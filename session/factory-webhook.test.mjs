import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { factoryReceipt } from './factory-webhook.mjs';

const key = 'ab'.repeat(32);
const repository = 'example/fixture';

function delivery({ action = 'opened', number = 1, name = repository, isPrivate = false } = {}) {
  const body = Buffer.from(JSON.stringify({ action, number, repository: { full_name: name, private: isPrivate }, pull_request: { number } }));
  const headers = {
    'x-github-event': 'pull_request', 'x-hub-signature-256': `sha256=${createHmac('sha256', key).update(body).digest('hex')}`,
    'x-github-delivery': `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`,
  };
  return [headers, body];
}

test('receiver rejects invalid key configuration before accepting connections', () => {
  for (const malformed of ['a'.repeat(63), 'z'.repeat(64)]) {
    assert.throws(() => factoryReceipt({ key: malformed, repositories: [repository] }), /64-character hexadecimal key/);
  }
});

test('ignored actions and disallowed repositories trigger no wake', async () => {
  const receive = factoryReceipt({ key, repositories: [repository], wake: () => assert.fail('unexpected wake') });
  assert.equal(await receive(...delivery({ action: 'labeled' })), 204);
  assert.equal(await receive(...delivery({ name: 'other/fixture' })), 403);
  assert.equal(await receive(...delivery({ isPrivate: true })), 403);
});

test('concurrent retries share one wake and reusing a signed body with a new delivery ID adds no wake', async () => {
  const pending = Promise.withResolvers();
  let wakes = 0;
  const receive = factoryReceipt({ key, repositories: [repository], wake: () => { wakes++; return pending.promise; } });
  const [headers, body] = delivery();
  const responses = Promise.all(Array.from({ length: 32 }, () => receive(headers, body)));
  pending.resolve();
  const statuses = await responses;
  assert.equal(statuses.filter(status => status === 202).length, 1);
  assert.equal(statuses.filter(status => status === 204).length, 31);
  assert.equal(await receive({ ...headers, 'x-github-delivery': '00000000-0000-0000-0000-000000000099' }, body), 204);
  assert.equal(wakes, 1);
});

test('a failed local signal can be retried with the same delivery', async () => {
  let wakes = 0;
  const receive = factoryReceipt({ key, repositories: [repository], wake: () => { if (++wakes === 1) throw new Error('offline'); } });
  assert.equal(await receive(...delivery()), 503);
  assert.equal(await receive(...delivery()), 202);
});
