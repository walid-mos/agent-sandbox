import { dequeue, enqueue, queued } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { endTerminal, isLive, isStopped, passes, save, terminalOf } from './workers.mjs';
import { canFinish, isPublished, lifecycleOf, publication, readyAt } from './worker-lifecycle.mjs';
import { keepResult } from './worker-results.mjs';

const REPORTABLE = new Set(['done', 'idle', 'blocked', 'error', 'finished']);
const TITLE_LABEL = 'agent.title';
const resumed = new Set();

function gitFacts(worker) {
  const options = { cwd: worker.worktree };
  return {
    branch: command('git', ['branch', '--show-current'], options),
    commit: command('git', ['rev-parse', '--short', 'HEAD'], options),
    ...publication(worker.worktree),
  };
}

function report(worker, terminal, status, wake, state, isSettled) {
  const facts = gitFacts(worker);
  const title = terminal.labels[TITLE_LABEL];
  const isFinished = isSettled && isPublished(facts);
  const result = isFinished ? keepResult(worker, terminal, state) : undefined;
  const note = { worker: worker.name, title, terminal: terminal.address, status, ...facts, cleanPass: passes(worker), pullRequest: worker.pullRequest, result };
  save({ ...worker, status, result, ...facts });
  command('pots', ['wake', '--bot', botId, '--id', wake, '--note', JSON.stringify(note)]);
  save({ ...worker, status, lastReport: wake, result, ...facts });
}

// A launch whose terminal never opened failed to start, which the bot hears about and answers with a send, so only a crash resumes.
// A resume gets a new launch ID, so the guard holds the worker's name: a launch that crashes as it starts is resumed once, not in a loop.
function recover(worker, state, pending) {
  if (state?.phase === 'closing') {
    if (!worker.isClosed) save({ ...worker, isClosed: true });
    return;
  }
  if ([!worker.terminal, worker.isClosed, pending.has(worker.name), resumed.has(worker.name)].some(Boolean)) return;
  enqueue({ worker: worker.name });
  resumed.add(worker.name);
}

// Pi records the follow-ups it accepted per launch, and a resume starts a new launch, so the ended launch's are dropped before they are sent again.
function forgetReceived(worker, state, pending) {
  if (!state?.received?.length) return;
  const requests = queued().filter(request => request.worker === worker.name);
  requests.filter(request => state.received.includes(request.file)).forEach(dequeue);
  if (requests.every(request => state.received.includes(request.file))) pending.delete(worker.name);
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

function reportCurrent(worker, terminal, state, isSettled) {
  const { status = 'starting', turn = 0 } = terminal;
  // Every input and turn writes a new generation, so only a settled result's generation names a wake: one per result, not per keystroke.
  const result = isSettled ? state.generation : 'open';
  const wake = `${worker.name}-${worker.launchId}-${turn}-${status}-${result}`;
  if (!REPORTABLE.has(status) || worker.lastReport === wake) return;
  report(worker, terminal, status, wake, state, isSettled);
}

function inspectLaunch(worker, view) {
  const state = lifecycleOf(worker);
  // A launch that settled ran, so a later crash of the worker may be resumed again.
  if (state?.phase === 'settled') resumed.delete(worker.name);
  const current = recordSession(worker, state);
  const terminal = terminalOf(current, view.terminals);
  if (!terminal || terminal.state === 'finished') {
    forgetReceived(current, state, view.pending);
    recover(current, state, view.pending);
    return undefined;
  }
  return inspectLive(current, terminal, state, view);
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
