import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { WORKERS } from './workers.mjs';

const LOCK_DESCRIPTOR = 3;

export function lockWorkerPublication(worker) {
  const descriptor = openSync(join(WORKERS, `${worker.name}.publication.lock`), 'a', 0o600);
  const { status, error } = spawnSync('flock', ['--exclusive', '--nonblock', `${LOCK_DESCRIPTOR}`], {
    stdio: ['ignore', 'ignore', 'ignore', descriptor],
  });
  if (status === 0) return () => closeSync(descriptor);
  closeSync(descriptor);
  throw new Error('dispatch: worker publication is busy or could not be locked. Inspect its state before retrying.', { cause: error });
}
