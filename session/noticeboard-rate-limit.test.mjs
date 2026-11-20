import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../probes/fixtures/noticeboards.mjs';
import { NoticeboardRateLimit } from './noticeboard-retry.mjs';
import { noticeboardPass } from './noticeboard-worker.mjs';

 test('a rate-limited send cannot cause early reconciliation or a repeated post', async () => {
  const context = fixture();
  let searches = 0;
  context.client.createCopy = async () => { context.effects.push('copy'); throw new NoticeboardRateLimit(60_000); };
  context.client.findCopy = async () => { searches += 1; return { status: 'unknown' }; };
  await noticeboardPass(context);
  await noticeboardPass({ ...context, event: undefined, now: context.now + 10_000 });
  assert.equal(searches, 0);
  assert.equal(context.store.records()[0].reason, 'rate-limited');
  await noticeboardPass({ ...context, event: undefined, now: context.now + 60_000 });
  assert.equal(searches, 1);
  assert.deepEqual(context.effects, ['react', 'copy']);
});

 test('an unbounded retry-after holds the uncertain operation for reconciliation', async () => {
  const context = fixture();
  context.client.createCopy = async () => { context.effects.push('copy'); throw new NoticeboardRateLimit(Number.MAX_SAFE_INTEGER); };
  await noticeboardPass(context);
  await noticeboardPass({ ...context, event: undefined, now: context.now + 1_000_000 });
  assert.equal(context.store.records()[0].reason, 'rate-limit-requires-reconciliation');
  assert.deepEqual(context.effects, ['react', 'copy']);
});
