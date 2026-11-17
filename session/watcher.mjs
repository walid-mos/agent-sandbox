import { spawn } from 'node:child_process';
import { mkdirSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { main } from './main.mjs';
import { enqueue, isRequest, QUEUE, queued } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { serveQueue } from './serve-queue.mjs';
import { endTerminal, isStopped, liveTerminals, passes, save, terminalOf, workers } from './workers.mjs';

const STARTUP_GRACE_MS = 120000;
// One change of a terminal comes as several events, so a pass waits for the burst to end.
const SETTLE_MS = 200;
const RESUBSCRIBE_MS = 5000;
// hc also reports title, label, size and document changes, and a pass reads none of them.
const WAKING_EVENTS = new Set(['created', 'lost', 'restarted', 'finished', 'removed', 'status', 'turn']);
const REPORTABLE = new Set(['done', 'idle', 'blocked', 'error', 'finished']);
const resumed = new Set();
let settling;
let deadline;

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
// No event marks the end of that wait, so the terminal carries the time a pass must look at it again.
function terminalState(worker, terminals, now) {
  const terminal = terminalOf(worker, terminals);
  if (!terminal) return { state: 'finished' };
  if (terminal.status || terminal.agent === 'pi') return terminal;
  const graceEnd = worker.startedAt + STARTUP_GRACE_MS;
  return now < graceEnd ? { ...terminal, lookAgainAt: graceEnd } : { state: 'finished' };
}

/** Reports and repairs one worker, and resolves to the time it needs another look, if any. */
function inspect(worker, terminals, now, pending) {
  // A stop can land while a resume is under way, so a stopped worker's terminal is ended whenever it is seen live.
  if (isStopped(worker)) {
    endTerminal(worker, terminals);
    return undefined;
  }
  const terminal = terminalState(worker, terminals, now);
  if (terminal.state === 'finished' && (worker.isComplete || pending.has(worker.name))) return undefined;
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
  const facts = gitFacts(worker);
  const report = JSON.stringify({ worker: worker.name, terminal: terminal.address, status, ...facts, cleanPass: passes(worker), pullRequest: worker.pullRequest });
  const isComplete = status === 'done' && facts.uncommitted === 0 && facts.unpushed === 0;
  command('pots', ['wake', '--bot', botId, '--id', wake, '--note', report]);
  save({ ...worker, status, lastReport: wake, isComplete, ...facts });
  return terminal.lookAgainAt;
}

function logFailure(subject, error) {
  process.stderr.write(`pots-watcher: ${subject}: ${error instanceof Error ? error.message : 'failed'}\n`);
}

function inspectLogged(worker, terminals, now, pending) {
  try {
    return inspect(worker, terminals, now, pending);
  } catch (error) {
    logFailure(worker.name, error);
    return undefined;
  }
}

function lookAgainAt(times) {
  clearTimeout(deadline);
  const due = times.filter(time => time !== undefined);
  if (due.length > 0) deadline = setTimeout(pass, Math.max(0, Math.min(...due) - Date.now()));
}

function pass() {
  try {
    const terminals = liveTerminals();
    const pending = new Set(queued().map(request => request.worker));
    const now = Date.now();
    const times = workers().map(worker => inspectLogged(worker, terminals, now, pending));
    // Inspection ends terminals, so the queue is served from a fresh list where their slots are free.
    serveQueue(liveTerminals(), logFailure);
    lookAgainAt(times);
  } catch (error) {
    logFailure('workers', error);
  }
}

function passSoon() {
  settling ??= setTimeout(() => {
    settling = undefined;
    pass();
  }, SETTLE_MS);
}

// The stream opens with every terminal and sends them again to a reader that fell behind, so both start a pass.
function isWaking(line) {
  try {
    const { method, params } = JSON.parse(line);
    if (method === 'heartbeat') return false;
    return method !== 'event' || WAKING_EVENTS.has(params?.type);
  } catch {
    return true;
  }
}

// A restart of hc's core ends the stream. The next one opens with every terminal, which catches up on what was missed.
function followTerminals() {
  const events = spawn('hc', ['events', '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  createInterface({ input: events.stdout }).on('line', line => {
    if (isWaking(line)) passSoon();
  });
  events.on('error', error => logFailure('hc events', error));
  events.on('close', () => setTimeout(followTerminals, RESUBSCRIBE_MS));
}

// Removing a request and writing its temporary file also stir the folder, and neither brings work.
function followQueue() {
  mkdirSync(QUEUE, { recursive: true });
  watch(QUEUE, (_event, file) => {
    if (!file || isRequest(file)) passSoon();
  });
}

main(import.meta, () => {
  followQueue();
  followTerminals();
});
