import { dirname, join } from 'node:path';
import { isIsolatedFactory } from './factory-authority.mjs';
import { askFactory } from './factory-channel.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { fileURLToPath } from 'node:url';
import { pullKey, pullUrl, readRecord, usesSharedRecord, withRecord, writeRecord } from './factory-records.mjs';
import { SUPERSEDED_SQUASH } from './factory-squash-publication.mjs';
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
    return usesSharedRecord(record) ? withRecord(record, (_, save) => save(record)) : writeRecord(record);
  }
  if (usesSharedRecord(record)) return deliverWakes(withRecord(record, (prior, save) => {
    if (prior?.generation >= record.generation) return prior;
    if (prior?.squashPublication && prior.stage !== SUPERSEDED_SQUASH) throw new Error('factory: a prior squash still needs readback');
    return save(queueFactoryWake(record));
  }));
  const saved = readRecord(record) ?? writeRecord(record);
  if (saved.stage !== record.stage) return saved;
  const review = bindReview(saved);
  wakeFactory(saved, { review }, [review]);
  return saved;
}

export function queueFactoryWake(record) {
  return { ...record, pendingWakes: [{ kind: 'review' }] };
}

export function queueReport(record, text) {
  return { ...record, pendingWakes: [{ kind: 'report', text }] };
}

export function deliverWakes(record) {
  for (const wake of record?.pendingWakes ?? []) {
    if (wake.kind === 'review') {
      const review = bindReview(record);
      wakeFactory(record, { review }, [review]);
    } else {
      const id = `pr-factory-${record.stage}-${pullKey(record)}-${record.generation}`;
      if (isIsolatedFactory) askFactory('reports', { id, text: wake.text });
    }
    withRecord(record, (current, save) => {
      if (JSON.stringify(current) === JSON.stringify(record)) save({ ...current, pendingWakes: [] });
    });
  }
  return record;
}

export function reportToPrincipal(record, text) {
  if (usesSharedRecord(record)) {
    const saved = withRecord(record, (prior, save) => {
      if (prior?.generation > record.generation) return prior;
      if (prior?.squashPublication && prior.stage !== SUPERSEDED_SQUASH) throw new Error('factory: a prior squash still needs readback');
      return save(queueReport(record, text));
    });
    return deliverWakes(saved);
  }
  command('pots', ['wake', '--bot', botId, '--from', PRINCIPAL_SOURCE, '--id', `pr-factory-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`, '--note', text]);
  return writeRecord(record);
}

export function reportStaleDraft(pull, id, owner) {
  const text = `PR factory: ${pullUrl(pull)} has been a draft for more than a day, and its description holds no valid BLOCKED UNTIL line. Send its worker this note, or tell the person when no worker owns it.`;
  command('pots', ['wake', '--bot', owner ?? botId, '--from', PRINCIPAL_SOURCE, '--id', id, '--note', text]);
}
