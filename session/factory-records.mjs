import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FACTORY_HOME = join(homedir(), '.config/agent-sandbox/factory');
const HEADS = join(FACTORY_HOME, 'heads');
const FULL_SHA = /^[0-9a-f]{40}$/;

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

export function writeRecord(record) {
  mkdirSync(HEADS, { recursive: true });
  const path = recordPath(record);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return record;
}
