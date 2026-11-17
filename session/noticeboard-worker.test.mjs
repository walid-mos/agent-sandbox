import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, channelId, authorId, source } from '../probes/fixtures/noticeboards.mjs';
import { noticeboardPass } from './noticeboard-worker.mjs';

const run = context => noticeboardPass(context);

 test('archives exact human text and attribution before considering removal', async () => {
  const context = fixture();
  await run(context);
  assert.deepEqual(context.effects, ['react', 'copy']);
  const [record] = context.store.records();
  assert.equal(record.stage, 'verified');
  assert.equal(record.reason, 'conditional-delete-unavailable');
  assert.equal(record.snapshot.content, 'Please keep this comment. @everyone');
  assert.equal(record.snapshot.author.id, authorId);
  assert.equal(record.snapshot.author.displayName, 'Fixture Person');
  const [copy] = context.copies.values();
  assert.match(copy.content, /Original author: Fixture Person/);
  assert.match(copy.content, /2026-01-01T12:00:00.000Z/);
  assert.deepEqual(copy.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
});

 test('keeps original when copy outcome is unknown and never blindly reposts after restart', async () => {
  const context = fixture();
  const create = context.client.createCopy;
  context.client.createCopy = async request => { await create(request); throw new Error('lost response'); };
  await run(context);
  await run({ ...context, event: undefined });
  assert.deepEqual(context.effects, ['react', 'copy']);
  assert.equal(context.store.records()[0].stage, 'copy-unknown');
});

 test('does not remove or verify a copy with missing content', async () => {
  const context = fixture();
  context.client.readCopy = async () => ({ content: 'truncated', files: [] });
  await run(context);
  assert.deepEqual(context.effects, ['react', 'copy']);
  assert.equal(context.store.records()[0].stage, 'held');
  assert.equal(context.store.records()[0].reason, 'copy-verification-failed');
});

 test('duplicate events cannot create a second copy', async () => {
  const context = fixture();
  await run(context);
  await run({ ...context, event: { ...context.event, id: 2 } });
  assert.deepEqual(context.effects, ['react', 'copy']);
  assert.equal(context.store.records().length, 1);
});

 test('an edit creates a separately attributed preserved revision', async () => {
  const context = fixture();
  await run(context);
  context.edit({ content: 'Edited comment', editedAt: '2026-01-01T12:30:00.000Z' });
  await run({ ...context, event: { ...context.event, id: 2, kind: 'update' } });
  assert.equal(context.store.records().length, 2);
  assert.equal(context.effects.filter(effect => effect === 'copy').length, 2);
  assert.equal(context.effects.includes('delete'), false);
});

 test('disabled and missing Manage Messages are read only', async () => {
  const context = fixture();
  await run({ ...context, configuration: {} });
  assert.deepEqual(context.effects, []);
  context.client.permissions = async () => ({ canRead: true, canWrite: true, canManageMessages: false });
  await run(context);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records().length, 0);
});

 test('never guesses that a bot or webhook entry is a comment', async () => {
  const context = fixture({ author: { ...source().author, isBot: true } });
  await run(context);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records().length, 0);
});

 test('pinned messages and component dialogs are never copied or deleted', async () => {
  for (const protectedFields of [{ isPinned: true }, { components: [{ type: 1 }] }]) {
    const context = fixture(protectedFields);
    await run(context);
    assert.deepEqual(context.effects, []);
    assert.equal(context.store.records().length, 0);
  }
});

 test('user text that resembles a credential is preserved exactly without a content scan', async () => {
  const context = fixture({ content: 'My private fixture password is not-a-real-credential.' });
  await run(context);
  const [record] = context.store.records();
  assert.equal(record.snapshot.content, 'My private fixture password is not-a-real-credential.');
  const [copy] = context.copies.values();
  const manifest = JSON.parse(Buffer.from(copy.files.at(-1).bytes, 'base64').toString('utf8'));
  assert.equal(manifest.original.content, 'My private fixture password is not-a-real-credential.');
});

 test('never queries outside the configured feed channels', async () => {
  const context = fixture();
  context.client.read = async () => { assert.fail('unconfigured channel was read'); };
  await run({ ...context, event: { ...context.event, channelId: '88888888888888888' } });
  assert.equal(context.store.records().length, 0);
  assert.equal(context.effects.includes('delete'), false);
  assert.equal(context.configuration.channels[0].channelId, channelId);
});
