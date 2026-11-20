import { spawnSync } from 'node:child_process';
import { closeSync, openSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isIsolatedFactory, landingRepository } from './factory-authority.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { pullUrl } from './github-url.mjs';

export const FACTORY_HOME = join(homedir(), '.config/agent-sandbox/factory');
const HEADS = join(FACTORY_HOME, 'heads');
const FULL_SHA = /^[0-9a-f]{40}$/;
const LOCK_WAIT_SECONDS = '30';
const LOCK_DESCRIPTOR = '3';

export function pullKey({ repository, number, head }) {
  return `${repository.replace('/', '-')}-${number}-${head}`;
}

export const PULL_ARGUMENT_COUNT = isDurableFactory ? 4 : 3;

export function pullArguments([repository, number, head, generation]) {
  if (isDurableFactory) return durablePull(repository, number, head, generation);
  return legacyPull(repository, number, head);
}

function durablePull(repository, number, head, generation) {
  const name = repositoryName(repository);
  const pullNumber = positiveInteger(number);
  if (pullNumber === undefined) throw new Error(`factory: expected a pull request number, got ${number}`);
  requireFullHead(head);
  const reviewGeneration = positiveInteger(generation);
  if (reviewGeneration === undefined) throw new Error('factory: use the command from the current Factory wake.');
  return { repository: name, number: pullNumber, head, generation: reviewGeneration };
}

function legacyPull(repository = '', number = '', head) {
  if (!/^[^/\s]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error(`factory: expected OWNER/REPOSITORY, got ${repository}`);
  if (!/^[1-9][0-9]*$/.test(number)) throw new Error(`factory: expected a pull request number, got ${number}`);
  requireFullHead(head);
  return { repository, number: Number(number), head };
}

function repositoryName(repository = '') {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error(`factory: expected OWNER/REPOSITORY, got ${repository}`);
  return repository.toLowerCase();
}

function requireFullHead(head = '') {
  if (!FULL_SHA.test(head)) throw new Error(`factory: expected the head commit's full SHA, got ${head}`);
}

function positiveInteger(text = '') {
  const number = Number(text);
  if (/^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(number)) return number;
}

export function logDirectory(pull) {
  return pullWorkspace('logs', pull);
}

export function pullWorkspace(folder, pull) {
  const path = join(FACTORY_HOME, folder, pullKey(pull));
  return isDurableFactory ? join(path, String(pull.generation)) : path;
}

const recordPath = pull => join(HEADS, `${pullKey(pull)}${isDurableFactory && !usesSharedRecord(pull) ? `-${pull.generation}` : ''}.json`);
export const usesSharedRecord = pull => isIsolatedFactory && pull.repository.toLowerCase() === landingRepository.toLowerCase();
const isLegacyRecord = name => /-[a-f0-9]{40}\.json$/.test(name);

export function readRecord(pull) {
  const path = recordPath(pull);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

export function recordedHeads() {
  if (!existsSync(HEADS)) return [];
  return readdirSync(HEADS).filter(name => isLegacyRecord(name) || (isDurableFactory && /-[a-f0-9]{40}-[1-9][0-9]*\.json$/.test(name)))
    .map(name => JSON.parse(readFileSync(join(HEADS, name), 'utf8')));
}

export function requireRecord(pull, stage) {
  const record = readRecord(pull);
  if (!record) throw new Error(`factory: ${pullUrl(pull)} at ${pull.head} has no review record.`);
  if (isDurableFactory && record.generation !== pull.generation) throw new Error('factory: checked review changed');
  if (record.stage !== stage) throw new Error(`factory: ${pullUrl(pull)} at ${pull.head} is ${record.stage}, and this step needs it ${stage}.`);
  return record;
}

export function withRecord(pull, operation) {
  mkdirSync(HEADS, { recursive: true });
  const lock = openSync(`${recordPath(pull)}.lock`, 'a', 0o600);
  try {
    const result = spawnSync('flock', ['--exclusive', '--wait', LOCK_WAIT_SECONDS, LOCK_DESCRIPTOR], { stdio: ['ignore', 'ignore', 'ignore', lock] });
    if (result.status !== 0) throw new Error('factory: could not lock the shared review record');
    return operation(readRecord(pull), saveRecord);
  } finally {
    closeSync(lock);
  }
}

export function writeRecord(record) {
  if (usesSharedRecord(record)) throw new Error('factory: shared records must be written under their record lock');
  return saveRecord(record);
}

function saveRecord(record) {
  mkdirSync(HEADS, { recursive: true });
  const path = recordPath(record);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return record;
}
