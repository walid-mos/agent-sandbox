import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, threadId } from '../probes/fixtures/noticeboards.mjs';
import { noticeboardConfiguration } from './noticeboard-policy.mjs';

 test('a discussion thread uses its starter message ID as Discord requires', () => {
  const { configuration } = fixture();
  configuration.channels[0].parentMessageId = threadId;
  delete configuration.channels[0].parentId;
  assert.equal(noticeboardConfiguration(configuration).channels[0].threadId, threadId);
});

 test('a configured discussion target with a different starter message is rejected', () => {
  const { configuration } = fixture();
  configuration.channels[0].parentMessageId = '88888888888888888';
  assert.throws(() => noticeboardConfiguration(configuration), /invalid bounded/);
});
