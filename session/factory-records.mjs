import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pullUrl } from './github-url.mjs';

export const FACTORY_HOME = join(homedir(), '.config/agent-sandbox/factory');
const HEADS = join(FACTORY_HOME, 'heads');
const FULL_SHA = /^[0-9a-f]{40}$/;
const LOCK_WAIT_SECONDS = '30';
const LOCK_DESCRIPTOR = '3';

export function pullKey({ repository, number, head }) {
  return `${repository.replace('/', '-')}-${number}-${head}`;
}

export function pullArguments([repository, number, head]) {
  if (!/^[^/\s]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) throw new Error(`factory: expected OWNER/REPOSITORY, got ${repository}`);
  if (!/^[1-9][0-9]*$/.test(number ?? '')) throw new Error(`factory: expected a pull request number, got ${number}`);
  if (!FULL_SHA.test(head ?? '')) throw new Error(`factory: expected the head commit's full SHA, got ${head}`);
  return { repository, number: Number(number), head };
}

export function logDirectory(pull) {
  return join(FACTORY_HOME, 'logs', pullKey(pull));
}

const recordPath = pull => join(HEADS, `${pullKey(pull)}.json`);

export function readRecord(pull) {
  const path = recordPath(pull);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

export function recordedHeads() {
  if (!existsSync(HEADS)) return [];
  return readdirSync(HEADS).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(HEADS, name), 'utf8')));
}

export function requireRecord(pull, stage) {
  const record = readRecord(pull);
  if (record?.stage !== stage) {
    throw new Error(`factory: ${pullUrl(pull)} at ${pull.head} is ${record?.stage ?? 'not seen yet'}, and this step needs it ${stage}.`);
  }
  return record;
}

function writeRecord(path, record) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return record;
}

export function withRecord(pull, operation) {
  mkdirSync(HEADS, { recursive: true });
  const path = recordPath(pull);
  const lock = openSync(`${path}.lock`, 'a', 0o600);
  try {
    const result = spawnSync('flock', ['--exclusive', '--wait', LOCK_WAIT_SECONDS, LOCK_DESCRIPTOR], {
      stdio: ['ignore', 'ignore', 'ignore', lock],
    });
    if (result.status !== 0) throw new Error(`factory: could not lock the record for ${pullUrl(pull)} at ${pull.head}.`, { cause: result.error });
    return operation(readRecord(pull), record => writeRecord(path, record));
  } finally {
    closeSync(lock);
  }
}
