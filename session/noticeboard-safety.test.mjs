import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, source } from '../probes/fixtures/noticeboards.mjs';
import { noticeboardPass } from './noticeboard-worker.mjs';

 test('identical snapshot fields in another object order cannot create duplicate archives', async () => {
  const context = fixture();
  await noticeboardPass(context);
  const author = source().author;
  context.edit({ author: { isBot: author.isBot, displayName: author.displayName, username: author.username, id: author.id } });
  await noticeboardPass({ ...context, event: { ...context.event, id: 2 } });
  assert.equal(context.effects.filter(effect => effect === 'copy').length, 1);
});

 test('refreshing an attachment bearer URL does not create a second archive of the same revision', async () => {
  const attachment = { id: '99999999999999999', filename: 'note.txt', size: 5,
    url: 'https://cdn.discordapp.com/attachments/fixture/note.txt?ex=first' };
  const context = fixture({ attachments: [attachment] });
  context.client.download = async () => Buffer.from('hello');
  await noticeboardPass(context);
  context.edit({ attachments: [{ ...attachment, url: 'https://cdn.discordapp.com/attachments/fixture/note.txt?ex=refreshed' }] });
  await noticeboardPass({ ...context, event: { ...context.event, id: 2 } });
  assert.equal(context.effects.filter(effect => effect === 'copy').length, 1);
});

 test('a forged copy from another author cannot satisfy preservation verification', async () => {
  const context = fixture();
  const read = context.client.readCopy;
  context.client.readCopy = async identity => ({ ...await read(identity), isOwnedByApp: false });
  await noticeboardPass(context);
  assert.equal(context.store.records()[0].reason, 'copy-verification-failed');
});

 test('unsupported author metadata is held instead of copied as if understood', async () => {
  const context = fixture({ author: { ...source().author, token: 'fixture-not-a-secret' } });
  await noticeboardPass(context);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records().length, 0);
});

 test('attachment metadata cannot direct the downloader to a local service or redirect', async () => {
  const context = fixture({ attachments: [{ id: '99999999999999999', filename: 'bad.txt', size: 2,
    url: 'http://127.0.0.1/private' }] });
  context.client.download = async () => { assert.fail('SSRF reached downloader'); };
  await noticeboardPass(context);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records()[0].stage, 'observed');
});

 test('oversize attachments leave the original and metadata without a partial copy', async () => {
  const context = fixture({ attachments: [{ id: '99999999999999999', filename: 'large.txt', size: 9 * 1024 * 1024,
    url: 'https://cdn.discordapp.com/attachments/fixture/large.txt' }] });
  context.client.download = async () => { assert.fail('oversize file was downloaded'); };
  await noticeboardPass(context);
  assert.deepEqual(context.effects, []);
  assert.equal(context.store.records()[0].snapshot.attachments[0].filename, 'large.txt');
});

 test('an unknown copy outcome exhausts bounded reconciliation and never retries creation', async () => {
  const context = fixture();
  context.client.createCopy = async () => { context.effects.push('copy'); throw new Error('unknown'); };
  let queries = 0;
  context.client.findCopy = async () => { queries += 1; return { status: 'not-found-in-bounded-window' }; };
  await noticeboardPass(context);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await noticeboardPass({ ...context, event: undefined, now: context.now + (attempt + 1) * 100_000 });
  }
  assert.deepEqual(context.effects, ['react', 'copy']);
  assert.equal(queries, 4);
  assert.equal(context.store.records()[0].stage, 'copy-unknown');
});
