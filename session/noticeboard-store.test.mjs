import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from '../probes/fixtures/noticeboards.mjs';
import { noticeboardStore } from './noticeboard-store.mjs';
import { noticeboardPass } from './noticeboard-worker.mjs';

function database(t) {
  const folder = mkdtempSync(join(tmpdir(), 'noticeboards-'));
  const path = join(folder, 'archive.sqlite');
  let store = noticeboardStore(path);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  return { get store() { return store; }, path,
    reopen() { store.close(); store = noticeboardStore(path); return store; } };
}

 test('persists uncertain copy before network send so restart cannot repost', async t => {
  const database_ = database(t);
  const context = fixture();
  const create = context.client.createCopy;
  context.client.createCopy = async request => { await create(request); throw new Error('response lost'); };
  await noticeboardPass({ ...context, store: database_.store });
  const reopened = database_.reopen();
  assert.equal(reopened.records().length, 1);
  assert.equal(reopened.records()[0].stage, 'copy-unknown');
  await noticeboardPass({ ...context, store: reopened, event: undefined, now: context.now + 10_000 });
  assert.deepEqual(context.effects, ['react', 'copy']);
  assert.equal(statSync(database_.path).mode & 0o777, 0o600);
});

 test('durable inbox retains failed work independently of its high-water cursor', t => {
  const database_ = database(t);
  const { event } = fixture();
  database_.store.enqueue([event]);
  const reopened = database_.reopen();
  assert.equal(reopened.cursor(), 1);
  assert.deepEqual(reopened.events(), [event]);
  reopened.enqueue([event]);
  assert.equal(reopened.events().length, 1);
  reopened.complete(event.id);
  assert.deepEqual(reopened.events(), []);
  assert.equal(reopened.cursor(), 1);
});

 test('retention removes verified archive bytes but keeps duplicate suppression and unknown copies', t => {
  const database_ = database(t);
  const key = 'a'.repeat(64);
  const unknownKey = 'b'.repeat(64);
  const base = { key, stage: 'verified', snapshot: { content: 'Private original' }, archive: { files: ['bytes'] },
    route: {}, copy: { id: 'copy' }, nonce: 'nonce', createdAt: 0, verifiedAt: 0 };
  database_.store.put(base);
  database_.store.put({ ...base, key: unknownKey, stage: 'copy-unknown' });
  database_.store.prune(31 * 24 * 60 * 60_000);
  const reopened = database_.reopen();
  assert.equal(reopened.get(key)?.stage, 'retained');
  assert.equal(reopened.get(key).archive, undefined);
  assert.equal(reopened.get(key).snapshot, undefined);
  assert.equal(reopened.get(unknownKey).archive.files[0], 'bytes');
});
