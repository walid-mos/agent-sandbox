import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKERS } from './workers.mjs';

// A request is its own file named by its time, so the names sort in arrival order and no two writers share a file.
export const QUEUE = join(WORKERS, 'queue');
const REQUEST = '.json';

export const isRequest = file => `${file}`.endsWith(REQUEST) && existsSync(join(QUEUE, file));

/** Asks the watcher to start the worker, or to bring it back, with the message when there is one. */
export function enqueue(request) {
  mkdirSync(QUEUE, { recursive: true });
  const path = join(QUEUE, `${Date.now()}-${randomUUID()}${REQUEST}`);
  writeFileSync(`${path}.tmp`, JSON.stringify(request), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function queued() {
  if (!existsSync(QUEUE)) return [];
  return readdirSync(QUEUE).filter(file => file.endsWith(REQUEST)).sort()
    .map(file => ({ ...JSON.parse(readFileSync(join(QUEUE, file), 'utf8')), file }));
}

export function dequeue(request) {
  rmSync(join(QUEUE, request.file), { force: true });
}
