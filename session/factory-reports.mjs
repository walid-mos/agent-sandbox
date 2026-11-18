import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullKey, pullUrl, writeRecord } from './factory-records.mjs';
import { bindReview } from './factory-review.mjs';
import { command, WITH_VAULT } from './run.mjs';
import { botId } from './sandbox.mjs';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
// The scan routine's name, and the source of the wakes it sends, by which the Factory bot recognises them.
export const WATCH = 'factory-watch';
const SESSION = dirname(fileURLToPath(import.meta.url));

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

// Each wake of these two goes out before its record is written, and its ID, one per stage, pull request and head commit, makes a rerun after a crash wake nobody twice.
export function handToFactory(record) {
  const { stage: event, ...pull } = record;
  const note = { event, pullRequest: pullUrl(pull), ...pull, commands: COMMANDS[event](pull) };
  command('pots', ['wake', '--bot', FACTORY_BOT.id, '--from', WATCH, '--id', `factory-${event}-${pullKey(pull)}-${pull.generation ?? 0}`, '--note', JSON.stringify(note)]);
  return writeRecord(record);
}

export function reportToPrincipal(record, text) {
  command('pots', ['wake', '--bot', botId, '--from', 'pr-factory', '--id', `pr-factory-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`, '--note', text]);
  return writeRecord(record);
}
