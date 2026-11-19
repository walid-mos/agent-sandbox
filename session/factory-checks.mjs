import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInputRevision, reusableCheckDigest } from './factory-check-inputs.mjs';
import { runOwnedContainer } from './factory-container.mjs';
import { copyAt, copyCheckInputs } from './factory-mirror.mjs';
import { FACTORY_HOME, pullKey } from './factory-records.mjs';
import { checkSteps } from './factory-repositories.mjs';
import { command } from './run.mjs';

const IMAGE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'factory-image');
const RUNS = join(FACTORY_HOME, 'runs');
const BASE_PLACEHOLDER = '{base}';
const ATTACKS = ['sh', '/factory/attacks.sh'];
const LEGACY_STEP_TIMEOUT_MS = 20 * 60 * 1000;

export function ensureImage() {
  const digest = createHash('sha256').update(readFileSync(join(IMAGE_DIRECTORY, 'Dockerfile'))).digest('hex');
  const tag = `agent-sandbox-factory:${digest.slice(0, 12)}`;
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore', timeout: 5_000, killSignal: 'SIGKILL' }).status !== 0) {
    command('docker', ['build', '--quiet', '--tag', tag, IMAGE_DIRECTORY], { timeout: 120_000, killSignal: 'SIGKILL' });
  }
  return tag;
}

// The container is the boundary: no credential, no session file but the copy and the read-only image folder, no capability, and no network unless the step asks for it.
function containerArguments({ image, workspace, base, imageDirectory = IMAGE_DIRECTORY }, step) {
  return ['--network', step.network ? 'bridge' : 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '2048', '--memory', '6g',
    '--env', 'HOME=/work/home', '--env', 'CI=true',
    '--volume', `${workspace}:/work`, '--volume', `${imageDirectory}:/factory:ro`, '--workdir', '/work/repository',
    image, ...step.run.map(part => (part === BASE_PLACEHOLDER ? base : part))];
}

function withStepLog(logs, step, run) {
  const log = join(logs, `${step.name}.log`);
  const output = openSync(log, 'w');
  try {
    return { name: step.name, ...run(output), log };
  } finally {
    closeSync(output);
  }
}

function legacyCheckStep(context, step) {
  const name = `factory-${process.pid}-${step.name}`;
  const args = ['run', '--rm', '--name', name, ...containerArguments(context, step)];
  return withStepLog(context.logs, step, output => {
    const run = spawnSync('docker', args, { stdio: ['ignore', output, output], timeout: LEGACY_STEP_TIMEOUT_MS });
    if (run.error) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    return { isPassed: run.status === 0 };
  });
}

function runStep(context, step) {
  const name = `factory-${context.runId}-${step.name}`;
  return withStepLog(context.logs, step, output => {
    const outcome = runOwnedContainer(context.jobs, context.runId, name, containerArguments(context, step), output);
    return { isPassed: outcome === 'passed', outcome };
  });
}

function freshWorkspace(name) {
  const workspace = join(RUNS, name);
  removeWorkspace(workspace);
  mkdirSync(join(workspace, 'home'), { recursive: true });
  return workspace;
}

// Checked code can drop its own write permission on what it made, so the owner gives it back before the removal.
function removeWorkspace(workspace) {
  spawnSync('chmod', ['-R', 'u+rwx', workspace], { stdio: 'ignore' });
  rmSync(workspace, { recursive: true, force: true });
}

function probeBoundary(image) {
  const workspace = freshWorkspace(`probe-${process.pid}`);
  mkdirSync(join(workspace, 'repository'));
  try {
    const probe = spawnSync('docker', ['run', '--rm', '--name', `factory-probe-${process.pid}`, ...containerArguments({ image, workspace }, { run: ATTACKS })], { encoding: 'utf8' });
    return { isClosed: probe.status === 0, output: `${probe.stdout}${probe.stderr}`.trim() };
  } finally {
    removeWorkspace(workspace);
  }
}

export function probe() {
  const result = probeBoundary(ensureImage());
  if (!result.isClosed) throw new Error(`factory: an attack from the check container succeeded, so no check runs.\n${result.output}`);
  return result.output;
}

function runCheckSteps(steps, execute) {
  const results = [];
  for (const step of steps) {
    const result = execute(step);
    results.push(result);
    if (!result.isPassed) break;
  }
  return results;
}

export function runLegacyChecks(pull, base, logs) {
  const image = ensureImage();
  const workspace = freshWorkspace(pullKey(pull));
  mkdirSync(logs, { recursive: true });
  try {
    copyAt(pull.repository, pull.head, join(workspace, 'repository'));
    return runCheckSteps(checkSteps(pull.repository), step => legacyCheckStep({ image, workspace, base, logs }, step));
  } finally {
    removeWorkspace(workspace);
  }
}

function reportStep(context, step, progress) {
  progress('step-start', { step: step.name });
  const result = runStep(context, step);
  progress('step-end', { step: step.name, isPassed: result.isPassed, outcome: result.outcome });
  return result;
}

function checkBoundary(context) {
  const repository = join(context.workspace, 'repository');
  mkdirSync(repository, { recursive: true });
  const boundary = runStep(context, { name: 'boundary', run: ATTACKS });
  removeWorkspace(repository);
  return boundary;
}

function checkWorkspace(pull, context, steps, progress, copy) {
  const repository = join(context.workspace, 'repository');
  mkdirSync(repository);
  copy(pull.repository, pull.head, repository);
  return runCheckSteps(steps, step => reportStep(context, step, progress));
}

export function effectiveCheckRevision(repository, image = ensureImage()) {
  return checkInputRevision({ steps: checkSteps(repository), image, imageDirectory: IMAGE_DIRECTORY }).inputRevision;
}

export function runChecks(pull, base, logs, progress, jobs) {
  const image = ensureImage();
  const steps = checkSteps(pull.repository);
  const runId = pull.generation;
  const directory = join(RUNS, String(runId));
  removeWorkspace(directory);
  const workspace = join(directory, 'work');
  try {
    return checkAttempt({ pull, base, logs, progress, jobs, image, steps, directory, workspace, runId });
  } finally {
    if (!jobs.container(runId)) removeRunWorkspace(runId);
  }
}

function checkAttempt({ pull, base, logs, progress, jobs, image, steps, directory, workspace, runId }) {
  const context = { image, workspace, base, logs, runId, jobs };
  mkdirSync(join(workspace, 'home'), { recursive: true });
  mkdirSync(logs, { recursive: true });
  const inputs = checkInputRevision({ steps, image, imageDirectory: IMAGE_DIRECTORY, snapshot: join(directory, 'helpers') });
  if (inputs.inputRevision !== pull.inputRevision) return undefined;
  const execution = { ...context, ...inputs };
  const boundary = checkBoundary(execution);
  if (!boundary.isPassed) return { checks: [boundary] };
  if (!steps.every(step => step.stableInputs === true)) {
    return { checks: checkWorkspace(pull, execution, steps, progress, copyAt) };
  }
  const inputDigest = reusableCheckDigest(pull, base, inputs.inputRevision);
  return checkStableWorkspace(pull, { ...execution, inputDigest }, steps, progress);
}

function checkStableWorkspace(pull, execution, steps, progress) {
  const { jobs, inputDigest } = execution;
  const previous = jobs.reusable(pull, inputDigest);
  if (previous) {
    progress('checks-reused', { from: previous.id });
    return { checks: previous.result.checks, inputDigest };
  }
  const checks = checkWorkspace(pull, execution, steps, progress, copyCheckInputs);
  return { checks, inputDigest };
}

export function removeRunWorkspace(id) {
  removeWorkspace(join(RUNS, String(id)));
}
