import { NOTICEBOARD_LIMITS } from './noticeboard-policy.mjs';

const MAX_RETRY_AFTER_MS = 60 * 60_000;

export class NoticeboardRateLimit extends Error {
  constructor(retryAfterMs) {
    super('noticeboards: the platform rate limit deferred this work.');
    this.retryAfterMs = retryAfterMs;
  }
}

export function deferredAttempt(record, error, now) {
  if (!(error instanceof NoticeboardRateLimit)) return { ...record, reason: 'operation-unconfirmed' };
  const delay = error.retryAfterMs;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_RETRY_AFTER_MS) {
    return { ...record, attempts: NOTICEBOARD_LIMITS.attempts, reason: 'rate-limit-requires-reconciliation' };
  }
  return { ...record, retryAt: Math.max(record.retryAt ?? now, now + delay), reason: 'rate-limited' };
}
