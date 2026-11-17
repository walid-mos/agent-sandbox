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
function deliver(request, terminal, worker) {
  if (!terminal?.status) return;
  const state = lifecycleOf(worker);
  if (state?.received.includes(request.file)) return dequeue(request);
  if (!state || state.phase === 'closing' || request.sentTo === worker.launchId) return;
  command('hc', ['send', '--', terminal.address, wrappedFollowUp(request)]);
  updateRequest(request, { sentTo: worker.launchId });
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
    reportNotStarted(request, worker, error);
    return false;
  }
  if (!request.message) dequeue(request);
  return true;
}

function serve(request, { records, terminals, running }) {
  const worker = records.get(request.worker);
  if (!worker || isStopped(worker)) {
    dequeue(request);
    return;
  }
  if (worker.owner !== botId) throw new Error('dispatch: worker ownership is unproven. Inspect its saved record before sending.');
  const terminal = terminalOf(worker, terminals);
  if (!terminal && terminals.some(candidate => candidate.name === worker.name)) throw new Error('dispatch: terminal ownership changed. Inspect it before sending.');
  if (terminal || running.has(worker.name)) {
    if (request.message) deliver(request, terminal, worker);
    else dequeue(request);
    return;
  }
  if (running.size < maxWorkers && start(request, worker)) running.add(worker.name);
}

/** Serves the requests in arrival order: a message reaches a worker that runs, and a waiting worker starts while a slot is free. */
export function serveQueue(terminals, logFailure) {
  const records = new Map(workers().map(worker => [worker.name, worker]));
  const running = new Set(terminals.map(terminal => terminal.name).filter(name => records.has(name)));
  for (const request of queued()) {
    try {
      serve(request, { records, terminals, running });
    } catch (error) {
      logFailure(request.worker, error);
    }
  }
}
