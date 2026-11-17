import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DIALOG_ID } from './human-contract.mjs';

export const HUMAN_HOME = join(homedir(), '.config/agent-sandbox/human');
const LOCK_SECONDS = 30;
const LOCK_DESCRIPTOR = 3;
const queues = new Map();

export function humanStore(folder = HUMAN_HOME) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const pathOf = id => {
    if (!DIALOG_ID.test(id)) throw new Error('human: invalid dialog ID.');
    return join(folder, `${id}.json`);
  };
  const get = id => existsSync(pathOf(id)) ? JSON.parse(readFileSync(pathOf(id), 'utf8')) : undefined;
  const save = record => {
    const path = pathOf(record.id);
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    return record;
  };
  const all = () => readdirSync(folder).filter(name => name.endsWith('.json') && DIALOG_ID.test(name.slice(0, -5))).map(name => get(name.slice(0, -5)));
  async function acquire(operation, key) {
    const descriptor = openSync(join(folder, `.lock-${key}`), 'a', 0o600);
    try {
      const lock = spawnSync('flock', ['-x', '-w', `${LOCK_SECONDS}`, `${LOCK_DESCRIPTOR}`], { stdio: ['ignore', 'ignore', 'ignore', descriptor] });
      if (lock.error || lock.status !== 0) throw new Error('human: dialog storage is busy. Try again.');
      return await operation({ get, save });
    } finally {
      closeSync(descriptor);
    }
  }
  function locked(operation, key) {
    if (!DIALOG_ID.test(key)) throw new Error('human: invalid lock ID.');
    const queueKey = `${folder}:${key}`;
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => acquire(operation, key));
    queues.set(queueKey, next);
    return next.finally(() => { if (queues.get(queueKey) === next) queues.delete(queueKey); });
  }
  const patch = (id, changes) => locked(() => save({ ...get(id), ...changes }), id);
  return { get, all, locked, patch };
}
