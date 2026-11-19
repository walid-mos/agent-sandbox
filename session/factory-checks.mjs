import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwnedContainer } from './factory-container.mjs';
import { copyAt } from './factory-mirror.mjs';
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
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status !== 0) {
    command('docker', ['build', '--quiet', '--tag', tag, IMAGE_DIRECTORY]);
  }
  return tag;
}

// The container is the boundary: no credential, no session file but the copy and the read-only image folder, no capability, and no network unless the step asks for it.
function containerArguments({ image, workspace, base }, step) {
  return ['--network', step.network ? 'bridge' : 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '2048', '--memory', '6g',
    '--env', 'HOME=/work/home', '--env', 'CI=true',
    '--volume', `${workspace}:/work`, '--volume', `${IMAGE_DIRECTORY}:/factory:ro`, '--workdir', '/work/repository',
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

export function runChecks(pull, base, logs, progress, jobs) {
  const image = ensureImage();
  const runId = pull.generation;
  const workspace = freshWorkspace(String(runId));
  mkdirSync(logs, { recursive: true });
  try {
    mkdirSync(join(workspace, 'repository'));
    const context = { image, workspace, base, logs, runId, jobs };
    const boundary = runStep(context, { name: 'boundary', run: ATTACKS });
    if (!boundary.isPassed) return [boundary];
    removeWorkspace(join(workspace, 'repository'));
    copyAt(pull.repository, pull.head, join(workspace, 'repository'));
    return runCheckSteps(checkSteps(pull.repository), step => reportStep(context, step, progress));
  } finally {
    if (!jobs.container(runId)) removeWorkspace(workspace);
  }
}

export function removeRunWorkspace(id) {
  removeWorkspace(join(RUNS, String(id)));
}
