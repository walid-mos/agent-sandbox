import { dirname, join } from 'node:path';
import { isDurableFactory } from './factory-mode.mjs';
import { fileURLToPath } from 'node:url';
import { pullKey, pullUrl, readRecord, writeRecord } from './factory-records.mjs';
import { bindReview } from './factory-review.mjs';
import { command, WITH_VAULT } from './run.mjs';
import { botId } from './sandbox.mjs';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
// The scan routine's name, and the source of the wakes it sends, by which the Factory bot recognises them.
export const WATCH = 'factory-watch';
const SESSION = dirname(fileURLToPath(import.meta.url));
const PRINCIPAL_SOURCE = 'pr-factory';

const factoryCli = (operation, ...arguments_) => ['node', join(SESSION, 'factory.mjs'), operation, ...arguments_].join(' ');
export const reconcileCommand = factoryCli('reconcile');
export const factoryCommand = (operation, ...arguments_) => `${WITH_VAULT} ${factoryCli(operation, ...arguments_)}`;

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

function wakeFactory(record, fields, arguments_) {
  const { stage: event, ...pull } = record;
  const note = { event, pullRequest: pullUrl(pull), ...pull, ...fields, commands: COMMANDS[event](arguments_) };
  command('pots', ['wake', '--bot', FACTORY_BOT.id, '--from', WATCH, '--id', `factory-${event}-${pullKey(pull)}-${pull.generation ?? 0}`, '--note', JSON.stringify(note)]);
}

export function handToFactory(record) {
  if (!isDurableFactory) {
    wakeFactory(record, {}, [record.repository, String(record.number), record.head]);
    return writeRecord(record);
  }
  const saved = readRecord(record) ?? writeRecord(record);
  if (saved.stage !== record.stage) return saved;
  const review = bindReview(saved);
  wakeFactory(saved, { review }, [review]);
  return saved;
}

export function reportToPrincipal(record, text) {
  command('pots', ['wake', '--bot', botId, '--from', PRINCIPAL_SOURCE, '--id', `pr-factory-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`, '--note', text]);
  return writeRecord(record);
}

export function reportStaleDraft(pull, id, owner) {
  const text = `PR factory: ${pullUrl(pull)} has been a draft for more than a day, and its description holds no valid BLOCKED UNTIL line. Send its worker this note, or tell the person when no worker owns it.`;
  command('pots', ['wake', '--bot', owner ?? botId, '--from', PRINCIPAL_SOURCE, '--id', id, '--note', text]);
}
