import { maxWorkers } from './limits.mjs';
import { dequeue, queued } from './queue.mjs';
import { command, failureReason } from './run.mjs';
import { botId } from './sandbox.mjs';
import { isStopped, launch, RESUME, terminalOf, workers } from './workers.mjs';

const hasStarted = worker => worker.startedAt !== undefined;

function conversationOf(worker, message) {
  if (!hasStarted(worker)) return [`@${worker.brief}`];
  return message ? [RESUME, '--', message] : [RESUME];
}

// Pi reads what it is sent once it runs, which its first status shows. hc refuses a blocked worker, and the message waits for the next pass.
function deliver(request, terminal) {
  if (!terminal?.status) return;
  command('hc', ['send', '--', terminal.address, request.message]);
  dequeue(request);
}

function reportNotStarted(request, worker, error) {
  const reason = failureReason(error) || (error instanceof Error ? error.message : 'hc did not answer');
  const note = JSON.stringify({ worker: worker.name, status: 'not started', reason, pullRequest: worker.pullRequest });
  command('pots', ['wake', '--bot', botId, '--id', `${worker.name}-${Date.now()}-not-started`, '--note', note]);
  dequeue(request);
}

/** Starts the worker a request names, and resolves to whether it took a slot. */
function start(request, worker) {
  try {
    launch(worker, conversationOf(worker, request.message));
  } catch (error) {
    // The bot hears of it once and the request leaves, so a worker that cannot start never holds the queue.
    reportNotStarted(request, worker, error);
    return false;
  }
  // A brief opens the first conversation, so a message that came with it stays queued until the worker shows a status.
  if (hasStarted(worker) || !request.message) dequeue(request);
  return true;
}

function serve(request, { records, terminals, running }) {
  const worker = records.get(request.worker);
  if (!worker || isStopped(worker)) {
    dequeue(request);
    return;
  }
  const terminal = terminalOf(worker, terminals);
  if (terminal || running.has(worker.name)) {
    if (request.message) deliver(request, terminal);
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
