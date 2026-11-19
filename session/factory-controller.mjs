import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, rmSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEP_TIMEOUT_MS } from './factory-container.mjs';
import { streamFactoryEvents } from './factory-events.mjs';
import { CHANGE_FILE, openJobs } from './factory-jobs.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { checkSteps, hasChecks } from './factory-repositories.mjs';
import { LOCK_BUSY, tryFactoryLock } from './factory-runner.mjs';
import { JOB_DIRECTORY } from './factory-state.mjs';
import { main } from './main.mjs';
import { WITH_VAULT } from './run.mjs';

const FACTORY = fileURLToPath(new URL('./factory.mjs', import.meta.url));
const LOCAL_BACKSTOP_MS = 10 * 60_000;
const DISCOVERY_BUDGET_MS = 150_000;
const WAKE_GAP_MS = 60_000;
const MAX_RUNNERS = 2;
const RUN_PREPARATION_MS = 10 * 60_000;

function runnerBudget({ repository }) {
  const steps = hasChecks(repository) ? checkSteps(repository).length : 0;
  return RUN_PREPARATION_MS + (steps + 1) * STEP_TIMEOUT_MS;
}
const PUBLICATION_RETRY_MS = 5_000;
const PUBLISHABLE = new Set(['complete', 'uncertain', 'interrupted']);

function launch(operation, arguments_, { budget, viaVault = true } = {}) {
  const invocation = [...(viaVault ? [WITH_VAULT] : []), process.execPath, FACTORY, operation, ...arguments_];
  const [binary, ...flags] = budget ? ['timeout', '--signal=KILL', `${budget / 1000}s`, ...invocation] : invocation;
  return new Promise(resolve => {
    const child = spawn(binary, flags, { detached: true, stdio: 'inherit' });
    child.once('error', () => resolve(undefined));
    child.once('exit', resolve);
  });
}

function scheduleDiscovery(jobs, refresh) {
  let next = 0;
  let timer;
  let isDiscovering = false;
  return () => {
    const revision = jobs.pendingWake();
    if (!revision || isDiscovering) return;
    if (Date.now() < next) return schedule();
    start(revision);
  };

  function schedule() {
    timer ??= setTimeout(() => { timer = undefined; refresh(); }, next - Date.now());
  }

  function start(revision) {
    isDiscovering = true;
    next = Date.now() + WAKE_GAP_MS;
    void launch('scan', [], { budget: DISCOVERY_BUDGET_MS }).then(status => {
      if (status === 0) jobs.consumeWake(revision);
      else {
        const pending = jobs.pendingWake();
        if (pending?.webhook === revision.webhook && pending.routine === revision.routine) next = Date.now() + LOCAL_BACKSTOP_MS;
      }
    }).catch(() => process.stderr.write('factory: failed to record discovery completion\n')).finally(() => {
      isDiscovering = false;
      refresh();
    });
  }
}

function scheduleExecution(jobs, refresh) {
  const launched = new Set();
  const deferred = new Set();
  const attemptedRecovery = new Set();
  return (pending, isBackstop) => {
    if (isBackstop) {
      attemptedRecovery.clear();
      deferred.clear();
    }
    const running = pending.filter(job => job.status === 'running');
    const recoverable = pending.filter(job => job.status === 'running' || job.status === 'uncertain');
    dispatchRecovery(recoverable, launched, attemptedRecovery, refresh);
    const reserved = new Set([...launched, ...running.map(job => job.id)]);
    const queued = pending.filter(job => job.status === 'queued' && !launched.has(job.id) && !deferred.has(job.id));
    for (const { id, subject } of queued.slice(0, Math.max(0, MAX_RUNNERS - reserved.size))) {
      const budget = runnerBudget(subject);
      launched.add(id);
      void launch('run-job', [String(id)], { budget }).then(() => {
        if (jobs.get(id)?.status === 'queued') deferred.add(id);
      }).catch(() => deferred.add(id)).finally(() => {
        launched.delete(id);
        refresh();
      });
    }
  };
}

function dispatchRecovery(running, launched, attemptedRecovery, refresh) {
  for (const { id } of running) {
    if (launched.has(id) || attemptedRecovery.has(id)) continue;
    attemptedRecovery.add(id);
    void launch('recover-job', [String(id)], { viaVault: false }).finally(refresh);
  }
}

function schedulePublication(refresh) {
  let isPublishing = false;
  const failed = new Set();
  const contended = new Set();
  return (pending, isBackstop) => {
    if (isBackstop) failed.clear();
    if (isPublishing) return;
    const job = pending.find(entry => PUBLISHABLE.has(entry.status) && !entry.isReported && !failed.has(entry.id) && !contended.has(entry.id));
    if (!job) return;
    isPublishing = true;
    void launch('publish-job', [String(job.id)], { budget: DISCOVERY_BUDGET_MS }).then(status => {
      if (status === LOCK_BUSY) {
        contended.add(job.id);
        setTimeout(() => { contended.delete(job.id); refresh(); }, PUBLICATION_RETRY_MS);
      } else if (status !== 0) failed.add(job.id);
    }).finally(() => {
      isPublishing = false;
      refresh();
    });
  };
}

function dispatch(jobs, subscribers) {
  let scheduled;
  const refresh = () => { scheduled ??= setImmediate(reconcile); };
  const discover = scheduleDiscovery(jobs, refresh);
  const execute = scheduleExecution(jobs, refresh);
  const publish = schedulePublication(refresh);
  function reconcile() {
    scheduled = undefined;
    run();
  }
  function run(isBackstop = false) {
    try {
      discover();
      const pending = jobs.pending();
      execute(pending, isBackstop);
      publish(pending, isBackstop);
      for (const replay of subscribers) replay();
    } catch {
      process.stderr.write('factory: controller could not reconcile the execution store\n');
    }
  }
  return { refresh, backstop: () => run(true) };
}

function isWake(request) {
  return request.method === 'POST' && request.url === '/wake'
    && request.headers['content-length'] === '0' && !request.headers['transfer-encoding'];
}

function wakeHandler(jobs, request, response) {
  if (!isWake(request)) {
    response.writeHead(400).end();
    return;
  }
  try {
    jobs.wake();
    response.writeHead(204).end();
  } catch {
    response.writeHead(503).end();
  }
}

function listen(path, handler, mode) {
  const previous = lstatSync(path, { throwIfNoEntry: false });
  if (previous && !previous.isSocket()) throw new Error('factory: listener path is not a socket');
  if (previous) rmSync(path);
  const server = createServer({ maxHeaderSize: 8192 }, handler);
  server.listen(path, () => chmodSync(path, mode));
}

const EVENTS_SOCKET = join(JOB_DIRECTORY, 'events.sock');

function startController(wakeSocket) {
  const unlock = tryFactoryLock(JOB_DIRECTORY, 'controller');
  if (!unlock) throw new Error('factory: a controller already owns this store');
  process.umask(0o077);
  const jobs = openJobs(JOB_DIRECTORY);
  process.once('exit', unlock);
  const subscribers = new Set();
  const { refresh, backstop } = dispatch(jobs, subscribers);
  const watcher = watch(JOB_DIRECTORY, (_, name) => { if (name === CHANGE_FILE || !name) refresh(); });
  watcher.on('error', () => process.stderr.write('factory: change notifications unavailable until controller restart\n'));
  if (wakeSocket) listen(wakeSocket, (request, response) => wakeHandler(jobs, request, response), 0o660);
  listen(EVENTS_SOCKET, (request, response) => streamFactoryEvents(request, response, jobs, subscribers), 0o600);
  setInterval(backstop, LOCAL_BACKSTOP_MS);
  refresh();
}

main(import.meta, () => {
  const [wakeSocket] = process.argv.slice(2);
  if (wakeSocket !== undefined && (!wakeSocket.startsWith('/') || wakeSocket === EVENTS_SOCKET)) {
    throw new Error('usage: factory-controller.mjs [ABSOLUTE_WAKE_SOCKET]');
  }
  if (!isDurableFactory) throw new Error('factory: durable mode is disabled');
  startController(wakeSocket);
});
