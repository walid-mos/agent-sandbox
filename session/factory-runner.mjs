import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { removeRunWorkspace } from './factory-checks.mjs';
import { cleanContainer } from './factory-container.mjs';

const LOCK_FD = 3;
export const LOCK_BUSY = 75;

export function tryFactoryLock(directory, key) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, `${key}.lock`), 'a', 0o600);
  const lock = spawnSync('flock', ['-n', '-E', String(LOCK_BUSY), String(LOCK_FD)], { stdio: ['ignore', 'ignore', 'ignore', fd] });
  if (lock.status === 0) return () => closeSync(fd);
  closeSync(fd);
  if (lock.status === LOCK_BUSY) return undefined;
  throw new Error('factory: could not acquire process lock', { cause: lock.error });
}

const pullLock = ({ repository, number }) => `${repository.replace('/', '@')}@${number}`;

export async function runJob(jobs, directory, id, check) {
  const queued = jobs.get(id);
  if (queued?.status !== 'queued') return;
  return runLocked(jobs, directory, queued, check);
}

async function runLocked(jobs, directory, { id, subject }, check) {
  const unlock = tryFactoryLock(directory, pullLock(subject));
  if (!unlock) return;
  try {
    if (jobs.claim(id)) await executeClaim(jobs, id, subject, check);
  } finally {
    unlock();
  }
}

async function executeClaim(jobs, id, subject, check) {
  try {
    const progress = (type, detail) => jobs.progress(id, type, detail);
    const result = await check(subject, progress);
    jobs.finish(id, 'complete', result);
  } catch (error) {
    process.stderr.write(`factory: run ${id} stopped: ${error.message}\n`);
    interrupt(jobs, id, 'runner failed before recording the outcome');
  }
}

function interrupt(jobs, id, reason) {
  if (!cleanContainer(jobs, id)) {
    jobs.finish(id, 'uncertain', { reason: `${reason}; container cleanup could not be confirmed` });
    return;
  }
  removeRunWorkspace(id);
  jobs.retry(id, reason);
}

export function recoverJob(jobs, directory, id) {
  const running = jobs.get(id);
  if (running?.status !== 'running') return;
  recoverLocked(jobs, directory, running);
}

function recoverLocked(jobs, directory, { id, subject }) {
  const unlock = tryFactoryLock(directory, pullLock(subject));
  if (!unlock) return;
  try {
    if (jobs.get(id).status === 'running') interrupt(jobs, id, 'runner disappeared before recording its result');
  } finally {
    unlock();
  }
}
