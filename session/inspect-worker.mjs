import { dequeue, enqueue, requestsFor } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { endTerminal, isLive, isStopped, passes, save, terminalOf, workerTitle } from './workers.mjs';
import { canFinish, isPublished, lifecycleOf, readyAt, reportFacts } from './worker-lifecycle.mjs';
import { waitsForHuman } from './worker-human.mjs';
import { keepResult } from './worker-results.mjs';

const REPORTABLE = new Set(['done', 'idle', 'blocked', 'error', 'finished']);

function report(worker, terminal, status, wake, state, facts, isSettled) {
  const title = workerTitle(worker, terminal);
  const isFinished = isSettled && isPublished(facts);
  const result = isFinished ? keepResult(worker, terminal, state) : undefined;
  const note = { worker: worker.name, kind: worker.kind, title, terminal: terminal.address, status, ...facts, cleanPass: passes(worker), pullRequest: worker.pullRequest, result };
  save({ ...worker, status, result, ...facts });
  command('pots', ['wake', '--bot', botId, '--id', wake, '--note', JSON.stringify(note)]);
  save({ ...worker, status, lastReport: wake, result, ...facts });
}

// A launch whose terminal never opened failed to start, which the bot hears about and answers with a send, so only a crash resumes.
function recover(worker, state, pending) {
  if (state?.phase === 'closing') {
    if (!worker.isClosed) save({ ...worker, isClosed: true });
    return;
  }
  if ([!worker.terminal, worker.isClosed, pending.has(worker.name), worker.recoveryAttempted].some(Boolean)) return;
  save({ ...worker, recoveryAttempted: true });
  enqueue({ worker: worker.name });
}

// Pi records the follow-ups it accepted per launch, and a resume starts a new launch, so the ended launch's are dropped before they are sent again.
function forgetReceived(worker, state, { queue, pending }) {
  if (!state?.received?.length || !pending.has(worker.name)) return;
  const isAccepted = request => state.received.includes(request.file);
  const requests = requestsFor(worker.name, queue);
  requests.filter(isAccepted).forEach(dequeue);
  if (requests.every(isAccepted)) pending.delete(worker.name);
}

function recordSession(worker, state) {
  if (!state?.sessionFile || state.sessionFile === worker.sessionFile) return worker;
  const current = { ...worker, sessionFile: state.sessionFile, sessionId: state.sessionId };
  save(current);
  return current;
}

// A closing worker had its result acknowledged and is exiting, so it has nothing new to report.
function inspectLive(worker, terminal, state, { now, terminals }) {
  if (state?.phase === 'closing') return undefined;
  const due = readyAt(state);
  if (now < due) return due;
  reportCurrent(worker, terminal, state, canFinish(state, terminal, terminals, now));
  return undefined;
}

// A worker that waits for the person is blocked however idle Pi looks, and never reaches the settled close.
function reportCurrent(worker, terminal, state, canSettle) {
  const isWaiting = terminal.status === 'blocked' || waitsForHuman(worker, terminal);
  const { turn = 0 } = terminal;
  const status = isWaiting ? 'blocked' : terminal.status ?? 'starting';
  if (!REPORTABLE.has(status)) return;
  const facts = reportFacts(worker);
  const result = !isWaiting && canSettle && isPublished(facts) ? state.generation : 'open';
  const publication = facts.publication ? `-${facts.publication}` : '';
  const wake = `${worker.name}-${worker.launchId}-${turn}-${status}${publication}-${result}`;
  if (worker.lastReport === wake) return;
  report(worker, terminal, status, wake, state, facts, canSettle && !isWaiting);
}

function inspectLaunch(worker, view) {
  const state = lifecycleOf(worker);
  const current = recordSession(worker, state);
  const terminal = terminalOf(current, view.terminals);
  if (!terminal || terminal.state === 'finished') {
    forgetReceived(current, state, view);
    recover(current, state, view.pending);
    return undefined;
  }
  const observed = state?.phase === 'settled' && current.recoveryAttempted ? { ...current, recoveryAttempted: false } : current;
  if (observed !== current) save(observed);
  return inspectLive(observed, terminal, state, view);
}

export function inspectWorker(worker, view) {
  if (worker.owner !== botId || !worker.launchId) return undefined;
  // The watcher's sweep has already removed a stopped worker's ended terminal, so only a live one is ended here.
  if (isStopped(worker)) {
    endTerminal(worker, view.terminals.filter(isLive));
    return undefined;
  }
  return inspectLaunch(worker, view);
}
