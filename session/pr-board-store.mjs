import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { boardPacket, boardRoute, digest, SECTION } from './pr-board-contract.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

export const BOARD_HOME = join(homedir(), '.config/agent-sandbox/pr-board');
const LOCK_DESCRIPTOR = 3;
const CLOCK_SKEW_MS = 60_000;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_PENDING_EVENTS = 4096;

export function boardStore(folder = BOARD_HOME) {
  const path = join(folder, 'state.json');
  return { read: () => readJson(path) ?? { sources: {}, events: {}, discord: {}, publisher: {} },
    save: state => writePrivateJson(path, state) };
}

export async function withBoardLock(operation, folder = BOARD_HOME) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const descriptor = openSync(join(folder, '.lock'), 'a', 0o600);
  try {
    const result = spawnSync('flock', ['-n', `${LOCK_DESCRIPTOR}`], { stdio: ['ignore', 'ignore', 'ignore', descriptor] });
    if (result.error) throw new Error('pr-board: could not acquire the service lock.');
    if (result.status !== 0) return;
    return await operation();
  } finally {
    closeSync(descriptor);
  }
}

function pendingSection(previous, packet) {
  if (previous?.publishedAt !== packet.publishedAt) return { snapshot: packet.snapshot, publishedAt: packet.publishedAt, parts: packet.parts, pages: {} };
  if (previous.snapshot !== packet.snapshot || previous.parts !== packet.parts) throw new Error('pr-board: conflicting snapshot identity.');
  return previous;
}

function acceptSection(previous = {}, packet) {
  if (packet.publishedAt <= (previous.current?.publishedAt ?? -1)) return previous;
  if (packet.publishedAt < (previous.pending?.publishedAt ?? -1)) return previous;
  const pending = pendingSection(previous.pending, packet);
  const known = pending.pages[packet.part];
  if (known && JSON.stringify(known) !== JSON.stringify(packet.pulls)) throw new Error('pr-board: conflicting snapshot part.');
  const pages = { ...pending.pages, [packet.part]: packet.pulls };
  if (Object.keys(pages).length !== packet.parts) return { ...previous, pending: { ...pending, pages } };
  const pulls = Array.from({ length: packet.parts }, (_, index) => pages[index]).flat();
  if (digest(pulls) !== packet.snapshot) throw new Error('pr-board: snapshot digest mismatch.');
  const keys = pulls.map(pull => `${pull.repository}#${pull.number}`);
  if (new Set(keys).size !== keys.length) throw new Error('pr-board: duplicate pull requests in a snapshot.');
  return { current: { snapshot: packet.snapshot, publishedAt: packet.publishedAt, pulls } };
}

function acceptEvents(previous, pot, events, now) {
  const next = Object.fromEntries(Object.entries(previous).filter(([, event]) => now - event.at <= EVENT_RETENTION_MS || !event.posted));
  for (const event of events) {
    if (event.at > now + CLOCK_SKEW_MS) throw new Error('pr-board: future event timestamp.');
    if (now - event.at > EVENT_RETENTION_MS) continue;
    const key = `${pot}:${event.id}`;
    if (next[key] && digest(next[key].claim) !== digest(event)) throw new Error('pr-board: conflicting event ID.');
    next[key] ??= { pot, claim: event, at: event.at };
  }
  if (Object.values(next).filter(event => !event.posted).length > MAX_PENDING_EVENTS) throw new Error('pr-board: event queue is full.');
  return next;
}

export function acceptBoard(state, pot, input, configuration, now) {
  const packet = boardPacket(JSON.stringify(input));
  boardRoute(packet, pot, configuration, true);
  if (packet.type !== SECTION) return { ...state, events: acceptEvents(state.events, pot, packet.events, now) };
  if (packet.publishedAt > now + CLOCK_SKEW_MS) throw new Error('pr-board: future snapshot timestamp.');
  return { ...state, sources: { ...state.sources, [pot]: acceptSection(state.sources[pot], packet) } };
}
