import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullKey, pullUrl, writeRecord } from './factory-records.mjs';
import { command, WITH_VAULT } from './run.mjs';
import { botId, sandbox } from './sandbox.mjs';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
// The scan routine's name, and the source of the wakes it sends, by which the Factory bot recognises them.
export const WATCH = 'factory-watch';
const SESSION = dirname(fileURLToPath(import.meta.url));
const PRINCIPAL_SOURCE = 'pr-factory';

export const factoryCommand = (operation, ...arguments_) => [WITH_VAULT, 'node', join(SESSION, 'factory.mjs'), operation, ...arguments_].join(' ');

const COMMANDS = {
  checked: facts => ({
    show: factoryCommand('show', ...facts),
    verdict: factoryCommand('verdict', ...facts, 'VERDICT', 'NOTES_FILE'),
    escalate: factoryCommand('escalate', ...facts, 'NOTE_FILE'),
  }),
  conflict: facts => ({
    resolve: factoryCommand('resolve', ...facts),
    push: factoryCommand('push', ...facts),
    escalate: factoryCommand('escalate', ...facts, 'NOTE_FILE'),
  }),
};

// Each wake of these two goes out before its record is written, and its ID, one per stage, pull request and head commit, makes a rerun after a crash wake nobody twice.
export function handToFactory(record) {
  const { stage: event, ...pull } = record;
  const facts = [pull.repository, String(pull.number), pull.head];
  const note = { event, pullRequest: pullUrl(pull), ...pull, commands: COMMANDS[event](facts) };
  command('pots', ['wake', '--bot', FACTORY_BOT.id, '--from', WATCH, '--id', `factory-${event}-${pullKey(pull)}-${pull.generation ?? 0}`, '--note', JSON.stringify(note)]);
  return writeRecord(record);
}

export function reportToPrincipal(record, text) {
  if (sandbox.pullRequestBoard?.enabled === true) return writeRecord(record);
  command('pots', ['wake', '--bot', botId, '--from', PRINCIPAL_SOURCE, '--id', `pr-factory-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`, '--note', text]);
  return writeRecord(record);
}

export function reportStaleDraft(pull, id, owner) {
  const text = `PR factory: ${pullUrl(pull)} has been a draft for more than a day, and its description holds no valid BLOCKED UNTIL line. Send its worker this note, or tell the person when no worker owns it.`;
  command('pots', ['wake', '--bot', owner ?? botId, '--from', PRINCIPAL_SOURCE, '--id', id, '--note', text]);
}
