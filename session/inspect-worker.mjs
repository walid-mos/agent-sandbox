import { enqueue } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { endTerminal, isStopped, passes, save, terminalOf } from './workers.mjs';
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
function recover(worker, state, pending) {
  if (state?.phase === 'closing') {
    save({ ...worker, isClosed: true });
    return;
  }
  if ([!worker.terminal, worker.isClosed, pending.has(worker.name), resumed.has(worker.launchId)].some(Boolean)) return;
  enqueue({ worker: worker.name });
  resumed.add(worker.launchId);
}

function recordSession(worker, state) {
  if (!state?.sessionFile || state.sessionFile === worker.sessionFile) return worker;
  const current = { ...worker, sessionFile: state.sessionFile, sessionId: state.sessionId };
  save(current);
  return current;
}

function inspectLive(worker, terminal, state, { now, terminals }) {
  const due = readyAt(state);
  if (now < due) return due;
  reportCurrent(worker, terminal, state, canFinish(state, terminal, terminals, now));
  return undefined;
}

function reportCurrent(worker, terminal, state, isSettled) {
  const { status = 'starting', turn = 0 } = terminal;
  const { generation = 'unmanaged' } = state ?? {};
  const wake = `${worker.name}-${worker.launchId}-${turn}-${status}-${generation}-${isSettled}`;
  if (!REPORTABLE.has(status) || worker.lastReport === wake) return;
  report(worker, terminal, status, wake, state, isSettled);
}

function inspectLaunch(worker, view) {
  const state = lifecycleOf(worker);
  const current = recordSession(worker, state);
  const terminal = terminalOf(current, view.terminals);
  if (!terminal || terminal.state === 'finished') {
    recover(current, state, view.pending);
    return undefined;
  }
  return inspectLive(current, terminal, state, view);
}

export function inspectWorker(worker, view) {
  if (worker.owner !== botId || !worker.launchId) return undefined;
  if (isStopped(worker)) {
    endTerminal(worker, view.terminals);
    return undefined;
  }
  return inspectLaunch(worker, view);
}
