import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parsedLine } from './jsonl.mjs';
import { botHome } from './sandbox.mjs';

export const TERMINAL = join(botHome, 'terminal');
const PLATFORM = join(TERMINAL, 'platform.jsonl');
const PERSON = 'abc';
const PLACE = `dm-${PERSON}`;
export const isFromBot = record => record?.person === 'bot';

export function conversation() {
  if (!existsSync(PLATFORM)) return [];
  return readFileSync(PLATFORM, 'utf8').split('\n').flatMap(parsedLine).filter(record => record.place === PLACE);
}

export function say(message) {
  const record = { id: `m-${randomUUID()}`, type: 'message', at: Date.now(), place: PLACE, person: PERSON, ...message };
  mkdirSync(TERMINAL, { recursive: true });
  appendFileSync(PLATFORM, `${JSON.stringify(record)}\n`);
  return record.id;
}

export function secretRequests(records) {
  const answered = new Set(records.map(record => record.answers).filter(Boolean));
  return new Map(records.filter(record => record.type === 'message' && isFromBot(record) && record.secret)
    .map(record => [record.id, { secret: record.secret, isOpen: !answered.has(record.id) }]));
}
