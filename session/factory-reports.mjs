import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTORY_HOME, pullKey, writeRecord } from './factory-records.mjs';
import { pullUrl } from './github-url.mjs';
import { isIsolatedFactory } from './factory-authority.mjs';
import { askFactory } from './factory-channel.mjs';
import { command, WITH_VAULT } from './run.mjs';
import { botId } from './sandbox.mjs';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
// The scan routine's name, and the source of the wakes it sends, by which the Factory bot recognises them.
export const WATCH = 'factory-watch';
const SESSION = dirname(fileURLToPath(import.meta.url));

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

const OUTBOX = join(FACTORY_HOME, 'report-outbox');

export function flushReports() {
  if (!isIsolatedFactory || !existsSync(OUTBOX)) return;
  for (const name of readdirSync(OUTBOX).filter(name => name.endsWith('.json'))) {
    const file = join(OUTBOX, name);
    try {
      askFactory('reports', JSON.parse(readFileSync(file, 'utf8')));
      unlinkSync(file);
    } catch {
      process.stderr.write('factory: a Principal report remains queued in the isolated outbox.\n');
      return;
    }
  }
}

export function reportToPrincipal(record, text) {
  const id = `pr-factory-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`;
  if (isIsolatedFactory) {
    mkdirSync(OUTBOX, { recursive: true, mode: 0o700 });
    writeFileSync(join(OUTBOX, `${id}.json`), JSON.stringify({ id, text }) + '\n', { mode: 0o600 });
    writeRecord(record);
    flushReports();
    return record;
  }
  command('pots', ['wake', '--bot', botId, '--from', 'pr-factory', '--id', id, '--note', text]);
  return writeRecord(record);
}
