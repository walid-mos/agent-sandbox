import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRequestId } from './door-messages.mjs';

const REQUESTS = join(homedir(), '.config/agent-sandbox/requests');
const RECORD_SUFFIX = '.json';
export const ASKED = 'asked';
export const RECEIVED = 'received';
export const OPEN = 'open';
export const ANSWERED = 'answered';
export const UNDELIVERED = 'undelivered';

// A request's ID names its record, so nothing but a well-formed ID ever reaches a path.
function recordPath(id) {
  if (!isRequestId(id)) throw new Error(`pots: ${id} is not a request ID. pots requests lists them.`);
  return join(REQUESTS, `${id}${RECORD_SUFFIX}`);
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));

export function find(id) {
  const path = recordPath(id);
  return existsSync(path) ? read(path) : undefined;
}

export function save(request) {
  const path = recordPath(request.id);
  mkdirSync(REQUESTS, { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function remove(id) {
  rmSync(recordPath(id), { force: true });
}

export function all() {
  if (!existsSync(REQUESTS)) return [];
  return readdirSync(REQUESTS).filter(name => name.endsWith(RECORD_SUFFIX))
    .map(name => read(join(REQUESTS, name))).sort((first, second) => first.at - second.at);
}
