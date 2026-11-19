import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwnedContainer } from './factory-container.mjs';
import { copyAt } from './factory-mirror.mjs';
import { FACTORY_HOME } from './factory-records.mjs';
import { checkSteps } from './factory-repositories.mjs';
import { command } from './run.mjs';

const IMAGE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'factory-image');
const RUNS = join(FACTORY_HOME, 'runs');
const BASE_PLACEHOLDER = '{base}';
const ATTACKS = ['sh', '/factory/attacks.sh'];

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

function runStep(context, step) {
  const log = join(context.logs, `${step.name}.log`);
  const output = openSync(log, 'w');
  const name = `factory-${context.runId}-${step.name}`;
  try {
    const outcome = runOwnedContainer(context.jobs, context.runId, name, containerArguments(context, step), output);
    return { name: step.name, isPassed: outcome === 'passed', outcome, log };
  } finally {
    closeSync(output);
  }
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
    const probe = spawnSync('docker', ['run', '--rm', ...containerArguments({ image, workspace }, { run: ATTACKS })], { encoding: 'utf8' });
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

function runCheckSteps(context, steps, progress) {
  const results = [];
  for (const step of steps) {
    progress('step-start', { step: step.name });
    const result = runStep(context, step);
    results.push(result);
    progress('step-end', { step: step.name, isPassed: result.isPassed, outcome: result.outcome });
    if (!result.isPassed) break;
  }
  return results;
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
    return runCheckSteps(context, checkSteps(pull.repository), progress);
  } finally {
    if (!jobs.container(runId)) removeWorkspace(workspace);
  }
}

export function removeRunWorkspace(id) {
  removeWorkspace(join(RUNS, String(id)));
}
