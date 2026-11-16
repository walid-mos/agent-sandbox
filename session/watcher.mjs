import { main } from './main.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { endTerminal, isStopped, launch, liveTerminals, passes, RESUME, save, terminalOf, workers } from './workers.mjs';

const INTERVAL_MS = 6000;
const STARTUP_GRACE_MS = 120000;
const REPORTABLE = new Set(['done', 'idle', 'blocked', 'error', 'finished']);
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

// hc shows no status and no pi agent while with-vault logs in, so a terminal that just started is not lost yet.
function terminalState(worker, terminals) {
  const terminal = terminalOf(worker, terminals);
  if (!terminal) return { state: 'finished' };
  const isStarting = Date.now() - worker.startedAt < STARTUP_GRACE_MS;
  if (terminal.status || terminal.agent === 'pi' || isStarting) return terminal;
  return { state: 'finished' };
}

function inspect(worker, terminals) {
  // A stop can land while a resume is under way, so a stopped worker's terminal is ended whenever it is seen live.
  if (isStopped(worker)) {
    endTerminal(worker, terminals);
    return;
  }
  const terminal = terminalState(worker, terminals);
  if (terminal.state === 'finished' && worker.isComplete) return;
  if (terminal.state === 'finished' && !resumed.has(worker.name)) {
    endTerminal(worker, terminals);
    launch(worker, [RESUME]);
    resumed.add(worker.name);
    return;
  }
  const status = terminal.state === 'finished' ? 'finished' : terminal.status ?? 'starting';
  if (status === 'working' && worker.isComplete) save({ ...worker, status, isComplete: false });
  // startedAt changes with every launch, so a resumed terminal never repeats a wake ID of the one before it.
  const wake = `${worker.name}-${worker.startedAt}-${terminal.turn ?? 0}-${status}`;
  if (!REPORTABLE.has(status) || worker.lastReport === wake) return;
  const facts = gitFacts(worker);
  const report = JSON.stringify({ worker: worker.name, terminal: terminal.address, status, ...facts, cleanPass: passes(worker), pullRequest: worker.pullRequest });
  const isComplete = status === 'done' && facts.uncommitted === 0 && facts.unpushed === 0;
  command('pots', ['wake', '--bot', botId, '--id', wake, '--note', report]);
  save({ ...worker, status, lastReport: wake, isComplete, ...facts });
}

function logFailure(subject, error) {
  process.stderr.write(`pots-watcher: ${subject}: ${error instanceof Error ? error.message : 'failed'}\n`);
}

function inspectLogged(worker, terminals) {
  try {
    inspect(worker, terminals);
  } catch (error) {
    logFailure(worker.name, error);
  }
}

function tick() {
  try {
    const terminals = liveTerminals();
    for (const worker of workers()) inspectLogged(worker, terminals);
  } catch (error) {
    logFailure('workers', error);
  }
}

main(import.meta, () => {
  tick();
  setInterval(tick, INTERVAL_MS);
});
