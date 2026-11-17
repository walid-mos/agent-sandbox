import { enqueue } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { endTerminal, isStopped, passes, save, terminalOf } from './workers.mjs';
import { canFinish, hasUncollectedHelpers, lifecycleOf, SETTLED_GRACE_MS } from './worker-lifecycle.mjs';
import { keepResult } from './worker-results.mjs';

const REPORTABLE = new Set(['done', 'idle', 'blocked', 'error', 'finished']);
const TITLE_LABEL = 'agent.title';
const resumed = new Set();

function gitFacts(worker) {
  const options = { cwd: worker.worktree };
  return {
    branch: command('git', ['branch', '--show-current'], options),
    commit: command('git', ['rev-parse', '--short', 'HEAD'], options),
    uncommitted: command('git', ['status', '--porcelain'], options).split('\n').filter(Boolean).length,
    unpushed: Number(command('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], options)),
  };
}

const terminalDetails = terminal => JSON.parse(command('hc', ['get', '--json', terminal.address]));

// Receipt covers this immutable result only, never a later turn.
function report(worker, terminal, status, wake, state, now) {
  const facts = gitFacts(worker);
  const title = terminal.address && terminalDetails(terminal).labels?.[TITLE_LABEL];
  const result = canFinish(state, terminal, now) && facts.uncommitted === 0 && facts.unpushed === 0 ? keepResult(worker, terminal, state) : undefined;
  const note = { worker: worker.name, title, terminal: terminal.address, status, ...facts, cleanPass: passes(worker), pullRequest: worker.pullRequest, result };
  save({ ...worker, status, result, ...facts });
  command('pots', ['wake', '--bot', botId, '--id', wake, '--note', JSON.stringify(note)]);
  save({ ...worker, status, lastReport: wake, result, ...facts });
}

/** Reports and repairs one worker, and resolves to the time it needs another look, if any. */
export function inspectWorker(worker, { terminals, now, pending }) {
  if (worker.owner !== botId || !worker.launchId) return undefined;
  // A stop can land while a resume is under way, so a stopped worker's terminal is ended whenever it is seen live.
  if (isStopped(worker)) {
    endTerminal(worker, terminals);
    return undefined;
  }
  const state = lifecycleOf(worker);
  if (state?.sessionFile && state.sessionFile !== worker.sessionFile) {
    worker = { ...worker, sessionFile: state.sessionFile, sessionId: state.sessionId };
    save(worker);
  }
  const terminal = terminalOf(worker, terminals) ?? { state: 'finished' };
  if (terminal.state === 'finished' && state?.phase === 'closing') {
    save({ ...worker, isComplete: true, isClosed: true });
    return undefined;
  }
  if (terminal.state === 'finished' && (worker.isComplete || worker.isClosed || pending.has(worker.name))) return undefined;
  if (terminal.state === 'finished' && !resumed.has(worker.launchId)) {
    endTerminal(worker, terminals);
    enqueue({ worker: worker.name });
    resumed.add(worker.launchId);
    return undefined;
  }
  const status = terminal.state === 'finished' ? 'finished' : terminal.status ?? 'starting';
  if (status === 'working' && worker.isComplete) save({ ...worker, status, isComplete: false });
  // startedAt changes with every launch, so a resumed terminal never repeats a wake ID of the one before it.
  const readyAt = state?.phase === 'settled' ? state.settledAt + SETTLED_GRACE_MS : undefined;
  if (readyAt && now < readyAt) return readyAt;
  const completion = hasUncollectedHelpers(terminal, terminals) ? undefined : state;
  const wake = `${worker.name}-${worker.startedAt}-${terminal.turn ?? 0}-${status}-${state?.generation ?? 'unmanaged'}-${canFinish(completion, terminal, now) ? 'result' : 'attention'}`;
  if (!REPORTABLE.has(status) || worker.lastReport === wake) return terminal.lookAgainAt;
  report(worker, terminal, status, wake, completion, now);
  return terminal.lookAgainAt;
}
