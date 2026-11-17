import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DOOR_COMMAND } from './door-command.mjs';
import { isRequestId } from './door-messages.mjs';

const REQUESTS = join(homedir(), '.config/agent-sandbox/requests');
const RECORD_SUFFIX = '.json';
const LOCK = join(REQUESTS, '.lock');
const LOCK_WAIT_SECONDS = 30;
const LOCK_DESCRIPTOR = 3;
const TEMPORARY_NAME_BYTES = 6;
export const ASKED = 'asked';
export const RECEIVED = 'received';
export const OPEN = 'open';
export const ANSWERED = 'answered';
export const UNDELIVERED = 'undelivered';
export const UNKNOWN = 'unknown';
export const REFUSED = 'refused';
export const RESENDABLE = [UNKNOWN, UNDELIVERED];
export const SETTLED = [ANSWERED, REFUSED];

// A request's ID names its record, so nothing but a well-formed ID ever reaches a path.
function recordPath(id) {
  if (!isRequestId(id)) throw new Error(`pots: ${id} is not a request ID. ${DOOR_COMMAND} requests lists them.`);
  return join(REQUESTS, `${id}${RECORD_SUFFIX}`);
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));

export function find(id) {
  const path = recordPath(id);
  return existsSync(path) ? read(path) : undefined;
}

export function save(request) {
  const path = recordPath(request.id);
  const temporary = `${path}.${process.pid}.${randomBytes(TEMPORARY_NAME_BYTES).toString('hex')}.tmp`;
  mkdirSync(REQUESTS, { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify(request)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

// flock locks the open file this process shares with it, so the lock lasts until this process closes the file or dies.
export function underLock(operation) {
  mkdirSync(REQUESTS, { recursive: true, mode: 0o700 });
  const lock = openSync(LOCK, 'a', 0o600);
  try {
    const { status, error } = spawnSync('flock', ['--exclusive', '--wait', `${LOCK_WAIT_SECONDS}`, `${LOCK_DESCRIPTOR}`], {
      stdio: ['ignore', 'ignore', 'ignore', lock],
    });
    if (error) throw new Error(`pots: flock could not run (${error.code}), so the requests stay as they were.`, { cause: error });
    if (status !== 0) throw new Error(`pots: another pots command held the requests for ${LOCK_WAIT_SECONDS} s, so they stay as they were. Try again.`);
    return operation();
  } finally {
    closeSync(lock);
  }
}

export function remove(id) {
  rmSync(recordPath(id), { force: true });
}

export function all() {
  if (!existsSync(REQUESTS)) return [];
  return readdirSync(REQUESTS).filter(name => name.endsWith(RECORD_SUFFIX))
    .map(name => read(join(REQUESTS, name))).sort((first, second) => first.at - second.at);
}
