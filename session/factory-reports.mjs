import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIsolatedFactory, REPORT_SOURCE } from './factory-authority.mjs';
import { askFactory } from './factory-channel.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { pullKey, readRecord, usesSharedRecord, withRecord, writeRecord } from './factory-records.mjs';
import { SUPERSEDED_SQUASH } from './factory-squash-publication.mjs';
import { bindReview } from './factory-review.mjs';
import { pullUrl } from './github-url.mjs';
import { command, WITH_VAULT } from './run.mjs';
import { botId } from './sandbox.mjs';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
// The scan routine's name, and the source of the wakes it sends, by which the Factory bot recognises them.
export const WATCH = 'factory-watch';
const SESSION = dirname(fileURLToPath(import.meta.url));
const PRINCIPAL_SOURCE = REPORT_SOURCE;

const factoryCli = (operation, ...arguments_) => ['node', join(SESSION, 'factory.mjs'), operation, ...arguments_].join(' ');
export const reconcileCommand = factoryCli('reconcile');
export const factoryCommand = (operation, ...arguments_) => [WITH_VAULT, factoryCli(operation, ...arguments_)].join(' ');

const LEGACY_COMMANDS = {
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

const DURABLE_COMMANDS = {
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

const COMMANDS = isDurableFactory ? DURABLE_COMMANDS : LEGACY_COMMANDS;
const wakeId = (prefix, record) => `${prefix}-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`;

function queueWake(record, wake) {
  return { ...record, pendingWakes: [...(record.pendingWakes ?? []), wake] };
}

function wakeFactory(record, fields, arguments_) {
  const { stage: event, ...pull } = record;
  const note = { event, pullRequest: pullUrl(pull), ...pull, ...fields, commands: COMMANDS[event](arguments_) };
  command('pots', ['wake', '--bot', FACTORY_BOT.id, '--from', WATCH, '--id', wakeId('factory', record), '--note', JSON.stringify(note)]);
}

export function queueFactoryWake(record) {
  if (isDurableFactory) return { ...record, pendingWakes: [{ kind: 'review' }] };
  const { stage: event, ...pull } = record;
  const note = { event, pullRequest: pullUrl(pull), ...pull, commands: LEGACY_COMMANDS[event](pull) };
  return queueWake(record, { bot: FACTORY_BOT.id, source: WATCH, id: wakeId('factory', record), note: JSON.stringify(note) });
}

export function queueReport(record, text) {
  if (isDurableFactory) return { ...record, pendingWakes: [{ kind: 'report', text }] };
  return queueWake(record, { bot: botId, source: PRINCIPAL_SOURCE, id: wakeId(PRINCIPAL_SOURCE, record), note: text });
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
  if (source === PRINCIPAL_SOURCE && isIsolatedFactory) {
    askFactory('reports', { id, text: note });
  } else if (source !== WATCH || id === wakeId('factory', current)) {
    command('pots', ['wake', '--bot', bot, '--from', source, '--id', id, '--note', note]);
  }
  acknowledge(record, id);
}

function deliverDurableWake(record, wake) {
  if (wake.kind !== 'report') {
    const review = bindReview(record);
    wakeFactory(record, { review }, [review]);
  } else if (isIsolatedFactory) {
    askFactory('reports', { id: `pr-factory-${record.stage}-${pullKey(record)}-${record.generation}`, text: wake.text });
  } else {
    command('pots', ['wake', '--bot', botId, '--from', PRINCIPAL_SOURCE, '--id', `pr-factory-${record.stage}-${pullKey(record)}-${record.generation}`, '--note', wake.text]);
  }
  withRecord(record, (current, save) => {
    if (JSON.stringify(current) === JSON.stringify(record)) save({ ...current, pendingWakes: [] });
  });
}

export function deliverWakes(record) {
  if (isDurableFactory) {
    for (const wake of record?.pendingWakes ?? []) deliverDurableWake(record, wake);
    return record;
  }
  for (const wake of record.pendingWakes ?? []) deliverWake(record, wake);
  return record;
}

export function handToFactory(record) {
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

export function reportToPrincipal(record, text) {
  if (isDurableFactory && usesSharedRecord(record)) {
    return deliverWakes(withRecord(record, (prior, save) => {
      if (prior?.generation > record.generation) return prior;
      if (prior?.squashPublication && prior.stage !== SUPERSEDED_SQUASH) throw new Error('factory: a prior squash still needs readback');
      return save(queueReport(record, text));
    }));
  }
  command('pots', ['wake', '--bot', botId, '--from', PRINCIPAL_SOURCE, '--id', `pr-factory-${record.stage}-${pullKey(record)}-${record.generation ?? 0}`, '--note', text]);
  return writeRecord(record);
}

export function reportStaleDraft(pull, id, owner) {
  const text = `PR factory: ${pullUrl(pull)} has been a draft for more than a day, and its description holds no valid BLOCKED UNTIL line. Send its worker this note, or tell the person when no worker owns it.`;
  command('pots', ['wake', '--bot', owner ?? botId, '--from', PRINCIPAL_SOURCE, '--id', id, '--note', text]);
}
