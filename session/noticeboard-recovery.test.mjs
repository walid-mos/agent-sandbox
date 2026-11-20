import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, copyId, threadId } from '../probes/fixtures/noticeboards.mjs';
import { noticeboardPass } from './noticeboard-worker.mjs';

const attachment = { id: '99999999999999999', filename: 'evidence.txt', size: 5, contentType: 'text/plain',
  url: 'https://cdn.discordapp.com/attachments/fixture/evidence.txt' };

 test('an attachment comment keeps its text and metadata and is held without reaction or copy', async () => {
  const context = fixture({ attachments: [attachment] });
  await noticeboardPass(context);
  const [record] = context.store.records();
  assert.equal(record?.snapshot.content, 'Please keep this comment. @everyone');
  assert.equal(record.snapshot.attachments[0].filename, 'evidence.txt');
  assert.equal(record.stage, 'held');
  assert.equal(record.reason, 'attachment-transport-unavailable');
  assert.deepEqual(context.effects, []);
});

 test('reconciles an uncertain send by verifying the existing copy without another post', async () => {
  const context = fixture();
  const create = context.client.createCopy;
  context.client.createCopy = async request => { await create(request); throw new Error('connection reset'); };
  await noticeboardPass(context);
  context.client.findCopy = async () => ({ status: 'found', copy: { id: copyId, channelId: threadId } });
  await noticeboardPass({ ...context, event: undefined, now: context.now + 10_000 });
  assert.equal(context.store.records()[0].stage, 'verified');
  assert.deepEqual(context.effects, ['react', 'copy']);
});

 test('an edit during the copy request never permits deletion of the changed original', async () => {
  const context = fixture();
  const create = context.client.createCopy;
  context.client.createCopy = async request => {
    context.edit({ content: 'Changed during send', editedAt: '2026-01-01T12:31:00.000Z' });
    return create(request);
  };
  await noticeboardPass(context);
  assert.equal(context.effects.includes('delete'), false);
  assert.equal(context.store.records()[0].reason, 'conditional-delete-unavailable');
  await noticeboardPass({ ...context, event: { ...context.event, id: 2, kind: 'update' } });
  assert.equal(context.store.records().length, 2);
});

 test('permission revocation after snapshot prevents all subsequent writes', async () => {
  const context = fixture();
  let reads = 0;
  context.client.permissions = async () => ({ canRead: true, canWrite: true,
    canManageMessages: ++reads === 1, isThreadBound: true });
  await noticeboardPass(context);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records().length, 1);
});

 test('a deleted source cannot cause a copy of invented event text', async () => {
  const context = fixture();
  context.client.read = async () => undefined;
  await noticeboardPass(context);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records().length, 0);
});
