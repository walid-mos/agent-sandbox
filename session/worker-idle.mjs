import { idleWorkerMs, idleWorkerPolicy } from './limits.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';
import { canRest, receiptPath, resultId } from './worker-lifecycle.mjs';
import { waitsForHuman } from './worker-human.mjs';
import { PUBLICATION } from './workers.mjs';

export const IDLE_RECHECK_MS = 5_000;
export const IDLE_PHASE = 'idle';
export const IDLE_CLOSE = 'idle';

function isWaitingForSession(state, terminal) {
  return waitsForHuman(state, terminal, { sessionFile: state.sessionFile });
}

export function idleWitness(state, terminal, terminals) {
  if (state?.phase !== IDLE_PHASE || !state.sessionFile || !state.sessionId) return undefined;
  const { status_ms: statusAt, turn } = terminal;
  if (!Number.isSafeInteger(statusAt) || statusAt <= 0 || !Number.isSafeInteger(turn)) return undefined;
  if (!canRest(state, terminal, terminals, isWaitingForSession)) return undefined;
  return JSON.stringify([resultId(state), terminal.status, statusAt, turn]);
}

export function hasNoUnreportedWork(facts) {
  if (facts.kind === 'task') return !facts.resultReady;
  return facts.uncommitted === 0 && facts.unpushed === 0 && (!facts.publication || facts.publication === PUBLICATION.published);
}

export function measureIdle(worker, terminal, state, view) {
  const { idleWorkers, monotonicNow, now, terminals, pending } = view;
  if (!idleWorkers) return undefined;
  const policy = idleWorkerPolicy();
  const witness = policy.enabled && !worker.result && !pending.has(worker.name) && idleWitness(state, terminal, terminals);
  if (!witness) {
    idleWorkers.delete(worker.name);
    return undefined;
  }
  const previous = idleWorkers.get(worker.name);
  const since = previous?.witness === witness ? previous.since : monotonicNow;
  idleWorkers.set(worker.name, { witness, since });
  const remaining = idleWorkerMs(policy) - (monotonicNow - since);
  if (remaining > 0) return now + Math.min(remaining, IDLE_RECHECK_MS);
  const file = receiptPath(worker);
  if (readJson(file)?.idleWitness !== witness) writePrivateJson(file, { id: resultId(state), idleWitness: witness });
  return now + IDLE_RECHECK_MS;
}
