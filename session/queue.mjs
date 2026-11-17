import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateJson } from './private-json.mjs';
import { WORKERS } from './workers.mjs';

// A request is its own file named by its time, so the names sort in arrival order and no two writers share a file.
export const QUEUE = join(WORKERS, 'queue');
const REQUEST = '.json';

export const isRequest = file => `${file}`.endsWith(REQUEST) && existsSync(join(QUEUE, file));

/** Asks the watcher to start the worker, or to bring it back, with the message when there is one. */
export function enqueue(request) {
  writePrivateJson(join(QUEUE, `${Date.now()}-${randomUUID()}${REQUEST}`), request);
}

export function queued() {
  if (!existsSync(QUEUE)) return [];
  return readdirSync(QUEUE).filter(file => file.endsWith(REQUEST)).sort()
    .map(file => ({ ...JSON.parse(readFileSync(join(QUEUE, file), 'utf8')), file }));
}

export const hasQueued = name => queued().some(request => request.worker === name);

export function updateRequest(request, changes) {
  writePrivateJson(join(QUEUE, request.file), { ...request, ...changes });
}

export function dequeue(request) {
  rmSync(join(QUEUE, request.file), { force: true });
}
