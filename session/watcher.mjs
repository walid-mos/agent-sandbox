import { spawn } from 'node:child_process';
import { mkdirSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { stopIdleStacks, stopMemoryStacks } from './idle-stacks.mjs';
import { inspectWorker } from './inspect-worker.mjs';
import { main } from './main.mjs';
import { memoryShortage } from './memory-signals.mjs';
import { isRequest, QUEUE, queued } from './queue.mjs';
import { serveQueue } from './serve-queue.mjs';
import { allTerminals, closeTerminal, isLive, isPublicationRecord, liveTerminals, terminalOf, WORKERS, workers } from './workers.mjs';
import { botId } from './sandbox.mjs';
import { createAdmission } from './worker-admission.mjs';
import { LIFECYCLE } from './worker-lifecycle.mjs';
import { RELEASE_RECHECK_MS, releasableHelpers, releaseOrder, requestRelease, stackReleaseWorktrees } from './worker-release.mjs';

// One change of a terminal comes as several events, so a pass waits for the burst to end.
const SETTLE_MS = 200;
const RESUBSCRIBE_MS = 5000;
// hc also reports title, label, size and document changes, and a pass reads none of them.
const WAKING_EVENTS = new Set(['created', 'lost', 'restarted', 'finished', 'removed', 'status', 'turn', 'label']);
let settling;

function writeFailure(subject, error) {
  process.stderr.write(`pots-watcher: ${subject}: ${error instanceof Error ? error.message : 'failed'}\n`);
}

// A worker's terminal that ended on its own, as in a crash, keeps its screen beside the record and leaves hc's list.
function sweep(terminals, records, logged) {
  terminals.filter(terminal => !isLive(terminal) && records.has(terminal.name) &&
    records.get(terminal.name).owner === botId && terminalOf(records.get(terminal.name), [terminal]))
    .forEach(terminal => logged(terminal.name, () => closeTerminal(records.get(terminal.name), terminal)));
}

export function createWatcher({ readText, now, logFailure = writeFailure } = {}) {
  const admission = createAdmission({ readText, now, logFailure });
  let deadline;

  function logged(subject, step) {
    try {
      return step();
    } catch (error) {
      logFailure(subject, error);
      return Date.now() + RESUBSCRIBE_MS;
    }
  }

  function lookAgainAt(times) {
    clearTimeout(deadline);
    const due = times.filter(time => time !== undefined);
    if (due.length > 0) deadline = setTimeout(pass, Math.max(0, Math.min(...due) - Date.now()));
  }

  // An unreadable signal never closes a worker: the pass fails here, keeps every candidate, and waits for the next one.
  function memoryReason() {
    try {
      return memoryShortage(readText);
    } catch (error) {
      logFailure('memory release', error);
      return undefined;
    }
  }

  // The kernel is short on memory, so the least-loss workload goes back first: a read-out helper terminal, a resting worktree's Compose projects, then a worker at rest; one release per pass lets its memory return before the next.
  function release(liveTerminals, resting, stackWorktrees) {
    const helper = releasableHelpers(liveTerminals)[0];
    const stackCandidates = stackReleaseWorktrees(stackWorktrees, liveTerminals);
    const stackCandidate = stackCandidates[0];
    if (!helper && !stackCandidate && resting.size === 0) return undefined;
    if (memoryReason() === undefined) return undefined;
    if (helper) {
      logged(helper.name, () => closeTerminal({ name: helper.name }, helper));
      return Date.now() + RELEASE_RECHECK_MS;
    }
    if (stopMemoryStacks(stackCandidates, logFailure)) return Date.now() + RELEASE_RECHECK_MS;
    if (resting.size === 0) return undefined;
    const [workerCandidate] = releaseOrder(resting.values());
    logged(workerCandidate.worker.name, () => requestRelease(workerCandidate));
    return Date.now() + RELEASE_RECHECK_MS;
  }

  function pass() {
    try {
      const terminals = allTerminals();
      const records = workers();
      sweep(terminals, new Map(records.map(worker => [worker.name, worker])), logged);
      const queue = queued();
      const view = { terminals, now: Date.now(), resting: new Map(),
        queue, pending: new Set(queue.map(request => request.worker)) };
      const times = records.map(worker => logged(worker.name, () => inspectWorker(worker, view)));
      // Inspection can end terminals, so the queue is served from a fresh list.
      const live = liveTerminals();
      const retryAfter = serveQueue(live, logFailure, admission);
      const admissionDue = retryAfter === undefined ? undefined : Date.now() + retryAfter;
      const stackWorktrees = records.filter(worker => worker.kind !== 'task').map(worker => worker.worktree);
      const releaseDue = release(live, view.resting, stackWorktrees);
      const idleStackDue = logged('idle stacks', () => stopIdleStacks(stackWorktrees, live, logFailure));
      lookAgainAt([...times, idleStackDue, admissionDue, releaseDue]);
    } catch (error) {
      logFailure('workers', error);
      lookAgainAt([Date.now() + RESUBSCRIBE_MS]);
    }
  }

  return pass;
}

const pass = createWatcher();

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
  events.on('error', error => writeFailure('hc events', error));
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
  process.stdout.write('pots-watcher: workers rest until the guest is short on memory\n');
  followQueue();
  mkdirSync(LIFECYCLE, { recursive: true });
  watch(LIFECYCLE, passSoon);
  watch(WORKERS, (_event, file) => {
    if (isPublicationRecord(file)) passSoon();
  });
  followTerminals();
  passSoon();
});
