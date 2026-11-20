import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writePrivateJson } from './private-json.mjs';
import { WORKERS } from './workers.mjs';

export const QUEUE = join(WORKERS, 'queue');
const LOCK = join(QUEUE, '.lock');
const SEQUENCE = join(QUEUE, '.sequence');
const LOCK_DESCRIPTOR = 3;
const LOCK_WAIT_SECONDS = 30;
const SEQUENCE_WIDTH = String(Number.MAX_SAFE_INTEGER).length;

function append(request) {
  const previous = readJson(SEQUENCE) ?? 0;
  const files = readdirSync(QUEUE).filter(isRequestName);
  const next = previous + 1;
  const file = `q-${String(next).padStart(SEQUENCE_WIDTH, '0')}.json`;
  if (!Number.isSafeInteger(next) || next < 1 || files.some(queuedFile => queuedFile >= file)) {
    throw new Error('dispatch: invalid worker queue sequence. Inspect the queue before retrying.');
  }
  // Publish the sequence first so an interrupted producer can leave a gap but cannot reuse an ID.
  writePrivateJson(SEQUENCE, next);
  writePrivateJson(join(QUEUE, file), { ...request, at: Date.now() });
}

// A request ID orders the queue, so a follow-up's deadline needs the time it was queued.
export const queuedAt = request => request.at;

export const isRequestName = file => /^[a-zA-Z0-9.-]+\.json$/.test(`${file}`);

export const isRequest = file => isRequestName(file) && existsSync(join(QUEUE, file));

function withQueueLock(operation) {
  mkdirSync(QUEUE, { recursive: true, mode: 0o700 });
  const lock = openSync(LOCK, 'a', 0o600);
  try {
    const { status, error } = spawnSync('flock', ['--exclusive', '--wait', `${LOCK_WAIT_SECONDS}`, `${LOCK_DESCRIPTOR}`], {
      stdio: ['ignore', 'ignore', 'ignore', lock],
    });
    if (status !== 0) throw new Error('dispatch: could not lock the worker queue. Check flock and retry.', { cause: error });
    return operation();
  } finally {
    closeSync(lock);
  }
}

export const enqueue = request => withQueueLock(() => append(request));

export function queued() {
  if (!existsSync(QUEUE)) return [];
  return readdirSync(QUEUE).filter(isRequestName).sort()
    .map(file => ({ ...JSON.parse(readFileSync(join(QUEUE, file), 'utf8')), file }));
}

export const requestsFor = (name, requests = queued()) => requests.filter(request => request.worker === name);

export const hasQueued = name => requestsFor(name).length > 0;

export function updateRequest(request, changes) {
  writePrivateJson(join(QUEUE, request.file), { ...request, ...changes });
}

export function dequeue(request) {
  withQueueLock(() => rmSync(join(QUEUE, request.file), { force: true }));
}
