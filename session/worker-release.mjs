import { sep } from 'node:path';
import { writePrivateJson } from './private-json.mjs';
import { canRest, readyAt, receiptPath, resultId } from './worker-lifecycle.mjs';
import { waitsForHuman } from './worker-human.mjs';
import { isInside } from './idle-stacks.mjs';
import { isLive } from './workers.mjs';

// A released worker leaves memory behind, so the next decision waits for it to come back to the kernel.
export const RELEASE_RECHECK_MS = 5_000;
export const RESTING_PHASE = 'resting';
export const SETTLED_PHASE = 'settled';
export const RELEASE_REASON = 'memory';
// A settled worker is at rest as well: its report is on the disk the bot reads, so releasing it takes no work away.
export const RELEASE_PHASES = [RESTING_PHASE, SETTLED_PHASE];
const AT_REST_STATUS = ['done', 'idle'];

function isWaitingForHuman(state, terminal) {
  return waitsForHuman(state, terminal, { sessionFile: state.sessionFile });
}

// A witness names the exact saved result and activity a release was decided on, so any change makes it a different worker.
export function restWitness(state, terminal, terminals) {
  if (!RELEASE_PHASES.includes(state?.phase) || !state.sessionFile || !state.sessionId) return undefined;
  const { status_ms: activeAt, turn } = terminal;
  if (!Number.isSafeInteger(activeAt) || activeAt <= 0 || !Number.isSafeInteger(turn)) return undefined;
  if (!canRest(state, terminal, terminals, isWaitingForHuman)) return undefined;
  return JSON.stringify([resultId(state), terminal.status, activeAt, turn]);
}

// A settled worker joins the pool only after the bot's settled grace, so its report has landed on the record first.
export function restingCandidate(worker, terminal, state, terminals, now) {
  const witness = restWitness(state, terminal, terminals);
  if (!witness || state.phase === SETTLED_PHASE && now < readyAt(state)) return undefined;
  return { worker, activeAt: terminal.status_ms, turn: terminal.turn, id: resultId(state), saved: Boolean(worker.result), witness };
}

/** Keeps the release candidates of this pass; a queued follow-up would wake the worker, so it is not one. */
export function trackCandidate(worker, terminal, state, view) {
  const { pending, resting, terminals, now } = view;
  const candidate = pending.has(worker.name) ? undefined : restingCandidate(worker, terminal, state, terminals, now);
  if (candidate) resting.set(worker.name, candidate);
  else resting.delete(worker.name);
}

/** Saved result first, then the least recently active, then the earliest turn and the name, so a decision never depends on the order the records were read. */
export function releaseOrder(candidates) {
  return [...candidates].sort((left, right) => Number(Boolean(right.saved)) - Number(Boolean(left.saved))
    || left.activeAt - right.activeAt || left.turn - right.turn || left.worker.name.localeCompare(right.worker.name));
}

export function requestRelease({ worker, id, witness }) {
  writePrivateJson(receiptPath(worker), { id, restWitness: witness });
}

const isOwnerOf = (owner, helper) => owner.address !== helper.address && (owner.address === helper.parent || helper.cwd && owner.cwd === helper.cwd);
const hasRead = (helper, owner) => Number(helper.labels?.[`agent.read.${owner.address}`]) >= helper.finished_ms;

/** Tier one: a finished clean-pass terminal whose owner has read it, or whose owner terminal is gone; the read one that has been left open longest goes first. */
export function releasableHelpers(terminals) {
  const live = terminals.filter(isLive);
  const helpers = live.filter(helper => helper.labels?.['pots.pass'] && AT_REST_STATUS.includes(helper.status));
  return helpers.filter(helper => !live.some(owner => isOwnerOf(owner, helper))
    || live.some(owner => isOwnerOf(owner, helper) && hasRead(helper, owner)))
    .sort((left, right) => (left.finished_ms ?? Infinity) - (right.finished_ms ?? Infinity) || left.name.localeCompare(right.name));
}

/** Tier two: the worktrees where every live terminal is at rest, the untouched ones and then the least recently used first. */
export function stackReleaseWorktrees(worktrees, liveTerminals) {
  const lastUse = insideTerminals => Math.max(0, ...insideTerminals.map(terminal => terminal.status_ms ?? 0));
  return worktrees.map(worktree => [worktree, liveTerminals.filter(terminal => isInside(terminal.cwd ?? '', worktree))])
    .filter(([, theirTerminals]) => theirTerminals.every(terminal => AT_REST_STATUS.includes(terminal.status)))
    .map(([worktree, theirTerminals]) => ({ worktree, lastUse: lastUse(theirTerminals) }))
    .sort((left, right) => left.lastUse - right.lastUse || left.worktree.localeCompare(right.worktree))
    .map(({ worktree }) => worktree);
}
