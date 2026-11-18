import { AdmissionDeferred } from './admission.mjs';
import { maxWorkers } from './limits.mjs';
import { dequeue, queued, updateRequest } from './queue.mjs';
import { command, failureReason } from './run.mjs';
import { botId } from './sandbox.mjs';
import { isStopped, launch, terminalOf, workers } from './workers.mjs';
import { lifecycleOf, wrappedFollowUp } from './worker-lifecycle.mjs';

function conversationOf(worker) {
  return worker.sessionFile ? [] : [`@${worker.brief}`];
}

// Pi reads what it is sent once it runs, which its first status shows. hc refuses a blocked worker, and the message waits for the next pass.
function sendWhenOpen(request, terminal, worker, state) {
  if (state.phase === 'closing' || request.sentTo === worker.launchId) return;
  command('hc', ['send', '--', terminal.address, wrappedFollowUp(request)]);
  updateRequest(request, { sentTo: worker.launchId });
}

function deliver(request, terminal, worker) {
  if (!terminal.status) return;
  const state = lifecycleOf(worker);
  if (!state) return;
  if (state.received.includes(request.file)) return dequeue(request);
  sendWhenOpen(request, terminal, worker, state);
}

function reportNotStarted(request, worker, error) {
  const reason = failureReason(error) || (error instanceof Error ? error.message : 'hc did not answer');
  const note = JSON.stringify({ worker: worker.name, status: 'not started', reason, pullRequest: worker.pullRequest });
  command('pots', ['wake', '--bot', botId, '--id', `${request.file}-not-started`, '--note', note]);
  if (!request.message) dequeue(request);
}

/** Starts the worker a request names, and resolves to whether it took a slot. */
function start(request, worker) {
  try {
    launch(worker, conversationOf(worker));
  } catch (error) {
    if (error instanceof AdmissionDeferred) return undefined;
    reportNotStarted(request, worker, error);
    return false;
  }
  if (!request.message) dequeue(request);
  return true;
}

function workerForRequest(request, records) {
  const worker = records.get(request.worker);
  if (!worker || isStopped(worker)) {
    dequeue(request);
    return undefined;
  }
  if (worker.owner !== botId) throw new Error('dispatch: worker ownership is unproven. Inspect its saved record before sending.');
  return worker;
}

function startWaiting(request, worker, running) {
  if (running.has(worker.name)) return;
  if (running.size >= maxWorkers) return;
  const started = start(request, worker);
  if (started) running.add(worker.name);
  return started === undefined ? 'deferred' : undefined;
}

function deliverRequest(request, terminal, worker) {
  if (!request.message) return dequeue(request);
  deliver(request, terminal, worker);
}

function serve(request, { records, terminals, running }) {
  const worker = workerForRequest(request, records);
  if (!worker) return;
  const terminal = terminalOf(worker, terminals);
  if (terminal) return deliverRequest(request, terminal, worker);
  if (terminals.some(candidate => candidate.name === worker.name)) throw new Error('dispatch: terminal ownership changed. Inspect it before sending.');
  return startWaiting(request, worker, running);
}

/** Serves the requests in arrival order: a message reaches a worker that runs, and a waiting worker starts while a slot is free. */
export function serveQueue(terminals, logFailure) {
  const records = new Map(workers().map(worker => [worker.name, worker]));
  const running = new Set(terminals.map(terminal => terminal.name).filter(name => records.has(name)));
  let isDeferred = false;
  for (const request of queued()) {
    try {
      if (serve(request, { records, terminals, running }) === 'deferred') isDeferred = true;
    } catch (error) {
      logFailure(request.worker, error);
    }
  }
  return isDeferred;
}
