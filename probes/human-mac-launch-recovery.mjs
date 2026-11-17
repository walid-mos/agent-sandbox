import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchService } from '../mac/launch-service.mjs';
import { launchNotice, launchRequest, noticeText, shownRequest } from '../session/launch-contract.mjs';
import { application, now, scenario } from './fixtures/mac-launch.mjs';

test('a failed Discord edit cannot withhold the committed start from the pot', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  await f.service.press(f.press());
  f.dependencies.discord.edit = async () => { throw new Error('message deleted'); };
  await f.service.tick();
  assert.deepEqual(f.reports.map(entry => entry.packet.status), ['offered', 'started']);
  assert.equal(f.store.get(f.request.launch).needsEdit, true);
  assert.deepEqual(f.runs, ['Reply ready.']);
});

test('an unreadable launch does not prevent another launch reporting its start', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  await f.service.press(f.press());
  const invalid = join(f.store.folder, `${'0'.repeat(32)}.json`);
  writeFileSync(invalid, '{}', { mode: 0o600 });
  chmodSync(invalid, 0o644);
  await f.service.tick();
  assert.deepEqual(f.reports.map(entry => entry.packet.status), ['offered', 'started']);
});

test('a crash after an unoffered closure decision still reports that closure after restart', async t => {
  const f = scenario(t);
  f.source.shown.state = 'superseded';
  const save = f.store.save;
  f.store.save = offer => {
    if (offer.state === 'superseded') throw new Error('crash before record saved');
    return save(offer);
  };
  await assert.rejects(f.service.notice(f.notice, application), /crash/);
  assert.equal(f.store.decision(f.request.launch)?.state, 'superseded');
  f.store.save = save;
  f.source.shown.state = 'open';
  await launchService(f.dependencies).tick();
  assert.deepEqual(f.reports.map(entry => entry.packet.status), ['superseded']);
  await f.service.notice(f.notice, application);
  assert.equal(f.posted.length, 0);
  assert.equal(f.runs.length, 0);
});

test('a transient source outage retries the notice after the gate restarts', async t => {
  const f = scenario(t);
  const show = f.dependencies.pots.show;
  f.dependencies.pots.show = async () => { throw new Error('source offline'); };
  await assert.rejects(f.service.notice(f.notice, application), /offline/);
  f.dependencies.pots.show = show;
  await launchService(f.dependencies).tick();
  assert.equal(f.posted.length, 1);
  await f.service.press(f.press());
  assert.deepEqual(f.runs, ['Reply ready.']);
});

test('a stale press gives the operator a reason and leaves approval unused', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  const click = f.press();
  f.source.time += 31_000;
  await f.service.press(click);
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.decision(f.request.launch), undefined);
  assert.match(f.told[0], /too old/);
});

test('a refused act is durably reported even when the pot initially cannot receive it', async t => {
  const f = scenario(t);
  const prompt = 'Change the launch-gate settings.';
  const request = launchRequest({ ...f.request, createdAt: now, acts: ['launch-gate'], prompt });
  f.source.shown = shownRequest(request, prompt, 'open');
  const notice = { ...f.notice, content: noticeText(launchNotice(request)) };
  f.source.isReportBroken = true;
  await f.service.notice(notice, application);
  f.source.isReportBroken = false;
  await launchService(f.dependencies).tick();
  assert.equal(f.reports.at(-1)?.packet.status, 'refused');
  assert.match(f.reports.at(-1)?.packet.detail, /launch-gate/);
  assert.equal(f.posted.length, 0);
  assert.equal(f.runs.length, 0);
});
