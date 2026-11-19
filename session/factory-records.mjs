import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FACTORY_HOME = join(homedir(), '.config/agent-sandbox/factory');
const HEADS = join(FACTORY_HOME, 'heads');
const FULL_SHA = /^[0-9a-f]{40}$/;

export function pullKey({ repository, number, head }) {
  return `${repository.replace('/', '-')}-${number}-${head}`;
}

export function pullUrl({ repository, number }) {
  return `https://github.com/${repository}/pull/${number}`;
}

export function pullArguments([repository, number, head, generation]) {
  const name = repositoryName(repository);
  const pullNumber = positiveInteger(number);
  if (pullNumber === undefined) throw new Error(`factory: expected a pull request number, got ${number}`);
  requireFullHead(head);
  const reviewGeneration = positiveInteger(generation);
  if (reviewGeneration === undefined) throw new Error('factory: use the command from the current Factory wake.');
  return { repository: name, number: pullNumber, head, generation: reviewGeneration };
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
  return join(FACTORY_HOME, 'logs', pullKey(pull), String(pull.generation));
}

const recordPath = pull => join(HEADS, `${pullKey(pull)}-${pull.generation}.json`);

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
  if (!record) throw new Error(`factory: ${pullUrl(pull)} at ${pull.head} has no review record.`);
  if (record.stage !== stage) throw new Error(`factory: ${pullUrl(pull)} at ${pull.head} is ${record.stage}, and this step needs it ${stage}.`);
  return record;
}

export function writeRecord(record) {
  mkdirSync(HEADS, { recursive: true });
  const path = recordPath(record);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return record;
}
