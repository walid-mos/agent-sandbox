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

export function cleanContainer(jobs, job) {
  const container = jobs.container(job);
  if (!container) return true;
  const { name, dockerId } = container;
  if (!DOCKER_ID.test(dockerId)) return false;
  try {
    if (present(dockerId)) {
      const inspect = docker(['inspect', '--type', 'container', '--format', `{{.Name}} {{index .Config.Labels "${OWNERSHIP}"}}`, dockerId]);
      if (inspect.status !== 0 || inspect.stdout.trim() !== `/${name} ${job}`) return false;
      docker(['rm', '--force', dockerId]);
      if (present(dockerId)) return false;
    }
    jobs.clearContainer(job);
    return true;
  } catch {
    return false;
  }
}

export function runOwnedContainer(jobs, job, name, arguments_, output, timeout = STEP_TIMEOUT_MS) {
  jobs.reserveContainer(job, name);
  const created = docker(['create', '--name', name, '--label', `${OWNERSHIP}=${job}`, ...arguments_]);
  const dockerId = created.stdout?.trim();
  if (created.error || created.status !== 0 || !DOCKER_ID.test(dockerId)) {
    throw new Error(`factory: Docker did not confirm creation of ${name}`);
  }
  jobs.identifyContainer(job, dockerId);
  const deadline = performance.now() + timeout;
  const started = docker(['start', '--attach', dockerId], { timeout, stdio: ['ignore', output, output] });
  const hasExpired = started.error?.code === 'ETIMEDOUT' || performance.now() >= deadline;
  const outcome = hasExpired ? undefined : docker(['inspect', '--type', 'container', '--format', '{{.State.Status}} {{.State.ExitCode}}', dockerId]);
  if (!cleanContainer(jobs, job)) throw new Error(`factory: cleanup could not be confirmed for ${name}`);
  if (hasExpired) return 'deadline';
  if (started.error || outcome?.status !== 0 || !/^exited \d+$/.test(outcome.stdout.trim())) {
    throw new Error(`factory: Docker did not confirm the exit of ${name}`);
  }
  return outcome.stdout.trim() === 'exited 0' ? 'passed' : 'failed';
}
