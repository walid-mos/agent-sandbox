import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullKey, pullUrl, readRecord, withRecord } from './factory-records.mjs';
import { bindReview } from './factory-review.mjs';
import { command, WITH_VAULT } from './run.mjs';
import { botId } from './sandbox.mjs';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
// The scan routine's name, and the source of the wakes it sends, by which the Factory bot recognises them.
export const WATCH = 'factory-watch';
const SESSION = dirname(fileURLToPath(import.meta.url));
const PRINCIPAL_SOURCE = 'pr-factory';

export const factoryCommand = (operation, ...arguments_) => [WITH_VAULT, 'node', join(SESSION, 'factory.mjs'), operation, ...arguments_].join(' ');

const COMMANDS = {
  checked: pull => {
    const review = bindReview(pull);
    return {
      show: factoryCommand('review', review, 'show'),
      verdict: factoryCommand('review', review, 'verdict', 'VERDICT', 'NOTES_FILE'),
      escalate: factoryCommand('review', review, 'escalate', 'NOTE_FILE'),
    };
  },
  conflict: ({ repository, number, head }) => {
    const facts = [repository, String(number), head];
    return {
      resolve: factoryCommand('resolve', ...facts),
      push: factoryCommand('push', ...facts),
      escalate: factoryCommand('escalate', ...facts, 'NOTE_FILE'),
    };
  },
};

const wakeId = (prefix, record) => `${prefix}-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`;

function queueWake(record, wake) {
  return { ...record, pendingWakes: [...(record.pendingWakes ?? []), wake] };
}

export function queueFactoryWake(record) {
  const { stage: event, pendingWakes, ...pull } = record;
  const note = { event, pullRequest: pullUrl(pull), ...pull, commands: COMMANDS[event](pull) };
  return queueWake({ ...record, pendingWakes }, { bot: FACTORY_BOT.id, source: WATCH, id: wakeId('factory', record), note: JSON.stringify(note) });
}

export function queueReport(record, note) {
  return queueWake(record, { bot: botId, source: PRINCIPAL_SOURCE, id: wakeId(PRINCIPAL_SOURCE, record), note });
}

function acknowledge(pull, id) {
  withRecord(pull, (record, save) => {
    if (!record?.pendingWakes?.some(wake => wake.id === id)) return;
    const { pendingWakes, ...head } = record;
    const remaining = pendingWakes.filter(wake => wake.id !== id);
    save(remaining.length ? { ...head, pendingWakes: remaining } : head);
  });
}

function deliverWake(record, { bot, source, id, note }) {
  const current = readRecord(record);
  if (!current?.pendingWakes?.some(wake => wake.id === id)) return;
  if (source !== WATCH || id === wakeId('factory', current)) {
    command('pots', ['wake', '--bot', bot, '--from', source, '--id', id, '--note', note]);
  }
  acknowledge(record, id);
}

export function deliverWakes(record) {
  for (const wake of record.pendingWakes ?? []) deliverWake(record, wake);
}

export function reportStaleDraft(pull, id, owner) {
  const text = `PR factory: ${pullUrl(pull)} has been a draft for more than a day, and its description holds no valid BLOCKED UNTIL line. Send its worker this note, or tell the person when no worker owns it.`;
  command('pots', ['wake', '--bot', owner ?? botId, '--from', PRINCIPAL_SOURCE, '--id', id, '--note', text]);
}
