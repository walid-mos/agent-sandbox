import { createHash } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKED_UNTIL = /^BLOCKED UNTIL: (\d{4}-\d{2}-\d{2}) — (.+)$/;

export const isOldDraft = ({ isDraft, createdAt }, now) => isDraft === true && now - Date.parse(createdAt) > DAY_MS;

function delaysWake(line, now) {
  const match = BLOCKED_UNTIL.exec(line);
  if (!match?.[2].trim()) return false;
  const day = match[1];
  const deadline = Date.parse(day);
  return now < deadline && new Date(deadline).toISOString().startsWith(`${day}T`);
}

export function staleDraftWakeId(pull, now) {
  if (!isOldDraft(pull, now)) return undefined;
  // The marker is author text: it can only hold this reminder back, and nothing reads it to check, judge, merge, close or label.
  if (pull.body.split(/\r?\n/).some(line => delaysWake(line, now))) return undefined;
  const { repository, number, headRefOid, lastEditedAt, title, body } = pull;
  const revision = JSON.stringify([repository.toLowerCase(), number, headRefOid, lastEditedAt, title, body]);
  return `pr-factory-stale-draft-${createHash('sha256').update(revision).digest('hex')}`;
}
