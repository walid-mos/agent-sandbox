import { AdmissionDeferred } from './admission.mjs';
import { dequeue, queued, updateRequest } from './queue.mjs';
import { command, failureReason } from './run.mjs';
import { botId } from './sandbox.mjs';
import { isStopped, launch, liveTerminals, terminalOf, workers } from './workers.mjs';
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

function startWaiting(request, worker, view) {
  if (view.retryAfter !== undefined) return;
  view.retryAfter = view.admission.check(view);
  if (view.retryAfter !== undefined) return;
  let needsSpacing = true;
  try {
    // hc can open the terminal and fail before returning its address.
    const started = start(request, worker);
    if (started === undefined) {
      needsSpacing = false;
      view.retryAfter = view.admission.attempted();
      return;
    }
    needsSpacing = started || liveTerminals().some(terminal => terminal.name === worker.name);
  } finally {
    if (needsSpacing) view.retryAfter = view.admission.attempted();
  }
}

function deliverRequest(request, terminal, worker) {
  if (!request.message) return dequeue(request);
  deliver(request, terminal, worker);
}

function serve(request, view) {
  const { records, terminals } = view;
  const worker = workerForRequest(request, records);
  if (!worker) return;
  const terminal = terminalOf(worker, terminals);
  if (terminal) return deliverRequest(request, terminal, worker);
  if (terminals.some(candidate => candidate.name === worker.name)) throw new Error('dispatch: terminal ownership changed. Inspect it before sending.');
  startWaiting(request, worker, view);
}

function launchAges(records, terminals) {
  const now = Date.now();
  let latestLaunchAge = Infinity;
  let pendingStatusAge = Infinity;
  for (const worker of records.values()) {
    if (worker.owner !== botId) continue;
    const terminal = terminalOf(worker, terminals);
    const startedAt = terminal?.created_ms ?? worker.startedAt;
    if ((!terminal && !worker.terminal) || !Number.isFinite(startedAt)) continue;
    const age = Math.max(0, now - startedAt);
    latestLaunchAge = Math.min(latestLaunchAge, age);
    if (terminal && !terminal.status) pendingStatusAge = Math.min(pendingStatusAge, age);
  }
  return { latestLaunchAge, pendingStatusAge };
}

export function serveQueue(terminals, logFailure, admission) {
  const records = new Map(workers().map(worker => [worker.name, worker]));
  const running = terminals.filter(terminal => records.has(terminal.name));
  const view = { records, terminals, running: new Set(running.map(terminal => terminal.name)).size, ...launchAges(records, running), admission };
  for (const request of queued()) {
    try {
      serve(request, view);
    } catch (error) {
      logFailure(request.worker, error);
    }
  }
  return view.retryAfter;
}
