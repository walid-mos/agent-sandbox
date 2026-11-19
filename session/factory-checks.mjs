import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyAt } from './factory-mirror.mjs';
import { FACTORY_HOME, pullKey } from './factory-records.mjs';
import { checkSteps } from './factory-repositories.mjs';
import { command } from './run.mjs';

const IMAGE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'factory-image');
const RUNS = join(FACTORY_HOME, 'runs');
const BASE_PLACEHOLDER = '{base}';
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
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
function containerArguments({ image, workspace, base }, step, name) {
  return ['run', '--rm', '--name', name, '--network', step.network ? 'bridge' : 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '2048', '--memory', '6g',
    '--env', 'HOME=/work/home', '--env', 'CI=true',
    '--volume', `${workspace}:/work`, '--volume', `${IMAGE_DIRECTORY}:/factory:ro`, '--workdir', '/work/repository',
    image, ...step.run.map(part => (part === BASE_PLACEHOLDER ? base : part))];
}

function runStep(context, step) {
  const log = join(context.logs, `${step.name}.log`);
  const output = openSync(log, 'w');
  const name = `factory-${process.pid}-${step.name}`;
  try {
    const run = spawnSync('docker', containerArguments(context, step, name), { stdio: ['ignore', output, output], timeout: STEP_TIMEOUT_MS });
    if (run.error) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    return { name: step.name, isPassed: run.status === 0, log };
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
    const probe = spawnSync('docker', containerArguments({ image, workspace }, { run: ATTACKS }, `factory-probe-${process.pid}`), { encoding: 'utf8' });
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

function runAll(context, steps) {
  const results = [];
  for (const step of steps) {
    const result = runStep(context, step);
    results.push(result);
    if (!result.isPassed) break;
  }
  return results;
}

export function runChecks(pull, base, logs) {
  const image = ensureImage();
  const workspace = freshWorkspace(pullKey(pull));
  mkdirSync(logs, { recursive: true });
  try {
    copyAt(pull.repository, pull.head, join(workspace, 'repository'));
    return runAll({ image, workspace, base, logs }, checkSteps(pull.repository));
  } finally {
    removeWorkspace(workspace);
  }
}
