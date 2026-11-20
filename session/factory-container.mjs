import { spawnSync } from 'node:child_process';

export const STEP_TIMEOUT_MS = 60 * 60 * 1000;
const CONTROL_TIMEOUT_MS = 30_000;
const OWNERSHIP = 'agent-sandbox.factory.run';
const DOCKER_ID = /^[a-f0-9]{64}$/;

function docker(arguments_, { timeout = CONTROL_TIMEOUT_MS, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  return spawnSync('docker', arguments_, { encoding: 'utf8', stdio, timeout, killSignal: 'SIGKILL' });
}

function present(dockerId) {
  const listed = docker(['ps', '--all', '--no-trunc', '--filter', `id=${dockerId}`, '--format', '{{.ID}}']);
  if (listed.error || listed.status !== 0) throw new Error('factory: Docker did not confirm container inventory');
  return listed.stdout.split(/\s+/).includes(dockerId);
}

function isOwned({ name, dockerId }, job) {
  const inspect = docker(['inspect', '--type', 'container', '--format', `{{.Name}} {{index .Config.Labels "${OWNERSHIP}"}}`, dockerId]);
  return inspect.status === 0 && inspect.stdout.trim() === `/${name} ${job}`;
}

function removeContainer(container, job) {
  if (!present(container.dockerId)) return true;
  if (!isOwned(container, job)) return false;
  docker(['rm', '--force', container.dockerId]);
  return !present(container.dockerId);
}

export function cleanContainer(jobs, job) {
  const container = jobs.container(job);
  if (!container) return true;
  try {
    const known = container.dockerId ? container : identifyReservedContainer(jobs, job, container);
    if (!known || !removeKnownContainer(known, job)) return false;
    jobs.clearContainer(job);
    return true;
  } catch {
    return false;
  }
}

function removeKnownContainer(container, job) {
  if (!DOCKER_ID.test(container.dockerId)) return false;
  return removeContainer(container, job);
}

function identifyReservedContainer(jobs, job, { name }) {
  const listed = docker(['ps', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
  const dockerId = listed.stdout?.trim();
  if (listed.error || listed.status !== 0 || !DOCKER_ID.test(dockerId)) return undefined;
  const container = { name, dockerId };
  if (!isOwned(container, job)) return undefined;
  jobs.identifyContainer(job, dockerId);
  return container;
}

function createOwnedContainer(jobs, job, name, arguments_) {
  jobs.reserveContainer(job, name);
  const created = docker(['create', '--name', name, '--label', `${OWNERSHIP}=${job}`, ...arguments_]);
  const dockerId = created.stdout?.trim();
  if (created.error || created.status !== 0 || !DOCKER_ID.test(dockerId)) {
    throw new Error(`factory: Docker did not confirm creation of ${name}`);
  }
  jobs.identifyContainer(job, dockerId);
  return dockerId;
}

function containerExit(dockerId, output, timeout) {
  const deadline = performance.now() + timeout;
  const started = docker(['start', '--attach', dockerId], { timeout, stdio: ['ignore', output, output] });
  if (stepExpired(started.error, deadline)) return 'deadline';
  if (started.error) return undefined;
  return exitOutcome(docker(['inspect', '--type', 'container', '--format', '{{.State.Status}} {{.State.ExitCode}}', dockerId]));
}

function stepExpired(error, deadline) {
  return error?.code === 'ETIMEDOUT' || performance.now() >= deadline;
}

function exitOutcome(inspected) {
  if (inspected.status !== 0 || !/^exited \d+$/.test(inspected.stdout.trim())) return undefined;
  return inspected.stdout.trim() === 'exited 0' ? 'passed' : 'failed';
}

export function runOwnedContainer(jobs, job, name, arguments_, output, timeout = STEP_TIMEOUT_MS) {
  const dockerId = createOwnedContainer(jobs, job, name, arguments_);
  const outcome = containerExit(dockerId, output, timeout);
  if (!cleanContainer(jobs, job)) throw new Error(`factory: cleanup could not be confirmed for ${name}`);
  if (!outcome) throw new Error(`factory: Docker did not confirm the exit of ${name}`);
  return outcome;
}
