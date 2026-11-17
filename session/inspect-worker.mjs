import { enqueue } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { closeTerminal, endTerminal, isStopped, keepScreen, passes, save, terminalOf } from './workers.mjs';

const STARTUP_GRACE_MS = 120000;
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

// hc shows no status and no pi agent while with-vault logs in, so a terminal that just started is not lost yet.
// No event marks the end of that wait, so the terminal carries the time a pass must look at it again.
function terminalState(worker, terminals, now) {
  const terminal = terminalOf(worker, terminals);
  if (!terminal) return { state: 'finished' };
  if (terminal.status || terminal.agent === 'pi') return terminal;
  const graceEnd = worker.startedAt + STARTUP_GRACE_MS;
  return now < graceEnd ? { ...terminal, lookAgainAt: graceEnd } : { state: 'finished' };
}

// The screen is kept before the bot wakes, because a done worker's terminal closes right after.
function report(worker, terminal, status, wake) {
  const facts = gitFacts(worker);
  const title = terminal.address && terminalDetails(terminal).labels?.[TITLE_LABEL];
  const screen = status === 'done' ? keepScreen(worker, terminal) : undefined;
  const note = { worker: worker.name, title, terminal: terminal.address, status, ...facts, cleanPass: passes(worker), pullRequest: worker.pullRequest, screen };
  const isComplete = status === 'done' && facts.uncommitted === 0 && facts.unpushed === 0;
  command('pots', ['wake', '--bot', botId, '--id', wake, '--note', JSON.stringify(note)]);
  const reported = { ...worker, status, lastReport: wake, isComplete, ...facts };
  save(reported);
  return reported;
}

// A message that reached the worker while it was reported starts a new turn, and the worker then keeps its terminal.
function closeIfStillDone(worker, terminal) {
  const current = terminalDetails(terminal);
  if (current.status?.state !== 'done' || current.turn !== terminal.turn) return;
  closeTerminal(worker, terminal);
  save({ ...worker, isClosed: true });
}

/** Reports and repairs one worker, and resolves to the time it needs another look, if any. */
export function inspectWorker(worker, { terminals, now, pending }) {
  // A stop can land while a resume is under way, so a stopped worker's terminal is ended whenever it is seen live.
  if (isStopped(worker)) {
    endTerminal(worker, terminals);
    return undefined;
  }
  const terminal = terminalState(worker, terminals, now);
  if (terminal.state === 'finished' && (worker.isComplete || worker.isClosed || pending.has(worker.name))) return undefined;
  // A worker whose record was saved but never queued, after a crash between the two, starts through this request too.
  if (terminal.state === 'finished' && !resumed.has(worker.name)) {
    endTerminal(worker, terminals);
    enqueue({ worker: worker.name });
    resumed.add(worker.name);
    return undefined;
  }
  const status = terminal.state === 'finished' ? 'finished' : terminal.status ?? 'starting';
  if (status === 'working' && worker.isComplete) save({ ...worker, status, isComplete: false });
  // startedAt changes with every launch, so a resumed terminal never repeats a wake ID of the one before it.
  const wake = `${worker.name}-${worker.startedAt}-${terminal.turn ?? 0}-${status}`;
  if (!REPORTABLE.has(status) || worker.lastReport === wake) return terminal.lookAgainAt;
  const reported = report(worker, terminal, status, wake);
  if (status === 'done') closeIfStillDone(reported, terminal);
  return terminal.lookAgainAt;
}
