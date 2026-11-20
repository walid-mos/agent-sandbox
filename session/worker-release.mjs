import { writePrivateJson } from './private-json.mjs';
import { canRest, receiptPath, resultId } from './worker-lifecycle.mjs';
import { waitsForHuman } from './worker-human.mjs';
import { PUBLICATION } from './workers.mjs';

// A released worker leaves memory behind, so the next decision waits for it to come back to the kernel.
export const RELEASE_RECHECK_MS = 5_000;
export const RESTING_PHASE = 'resting';
export const RELEASE_REASON = 'memory';

function isWaitingForSession(state, terminal) {
  return waitsForHuman(state, terminal, { sessionFile: state.sessionFile });
}

export function hasNoUnreportedWork(facts) {
  if (facts.kind === 'task') return !facts.resultReady;
  return facts.uncommitted === 0 && facts.unpushed === 0 && (!facts.publication || facts.publication === PUBLICATION.published);
}

// A witness names the exact saved result and activity a release was decided on, so any change makes it a different worker.
export function restWitness(state, terminal, terminals) {
  if (state?.phase !== RESTING_PHASE || !state.sessionFile || !state.sessionId) return undefined;
  const { status_ms: activeAt, turn } = terminal;
  if (!Number.isSafeInteger(activeAt) || activeAt <= 0 || !Number.isSafeInteger(turn)) return undefined;
  if (!canRest(state, terminal, terminals, isWaitingForSession)) return undefined;
  return JSON.stringify([resultId(state), terminal.status, activeAt, turn]);
}

export function restingCandidate(worker, terminal, state, terminals) {
  const witness = restWitness(state, terminal, terminals);
  if (!witness || worker.result) return undefined;
  return { worker, activeAt: terminal.status_ms, turn: terminal.turn, id: resultId(state), witness };
}

/** Keeps the release candidates of this pass; a worker that owes anything is not one. */
export function trackCandidate(worker, terminal, state, view, facts) {
  const { pending, resting, terminals } = view;
  const candidate = facts && hasNoUnreportedWork(facts) && !pending.has(worker.name)
    ? restingCandidate(worker, terminal, state, terminals) : undefined;
  if (candidate) resting.set(worker.name, candidate);
  else resting.delete(worker.name);
}

/** Least recently active first, then the earliest turn and the name, so a decision never depends on the order the records were read. */
export function releaseOrder(candidates) {
  return [...candidates].sort((left, right) => left.activeAt - right.activeAt || left.turn - right.turn || left.worker.name.localeCompare(right.worker.name));
}

export function requestRelease({ worker, id, witness }) {
  writePrivateJson(receiptPath(worker), { id, restWitness: witness });
}
