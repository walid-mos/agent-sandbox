import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, eventOf, VERDICTS } from './pr-board-contract.mjs';
import { BOARD_HOME } from './pr-board-store.mjs';
import { sandbox } from './sandbox.mjs';

const JOURNAL = join(BOARD_HOME, 'factory-events');

export function captureFactoryEvent(record) {
  if (sandbox.pullRequestBoard?.enabled !== true) return;
  const kind = record.stage === 'merged' ? 'merge' : record.stage === 'judged' && VERDICTS.includes(record.verdict) ? 'verdict' : undefined;
  if (!kind) return;
  const id = digest([record.repository, record.number, record.head, record.generation ?? 0, kind, kind === 'verdict' ? record.verdict : record.mergeCommit]);
  mkdirSync(JOURNAL, { recursive: true, mode: 0o700 });
  const path = join(JOURNAL, `${id}.json`);
  if (existsSync(path)) return;
  const event = eventOf({ id, repository: record.repository, number: record.number, kind, at: Date.now(), ...(kind === 'verdict' && { verdict: record.verdict }) });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(event), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export function factoryEvents() {
  if (sandbox.pullRequestBoard?.enabled !== true || !existsSync(JOURNAL)) return [];
  return readdirSync(JOURNAL).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => eventOf(JSON.parse(readFileSync(join(JOURNAL, name), 'utf8')))).sort((left, right) => left.at - right.at);
}
