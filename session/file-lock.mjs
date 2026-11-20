import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_SECONDS = 30;
const LOCK_DESCRIPTOR = 3;

export function underFileLock(path, operation) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, 'a', 0o600);
  try {
    const acquired = spawnSync('flock', ['-x', '-w', `${LOCK_SECONDS}`, `${LOCK_DESCRIPTOR}`], { stdio: ['ignore', 'ignore', 'ignore', descriptor] });
    if (acquired.error || acquired.status !== 0) throw new Error('task: storage lock unavailable. Retry the same identity when flock is available.');
    return operation();
  } finally {
    closeSync(descriptor);
  }
}
