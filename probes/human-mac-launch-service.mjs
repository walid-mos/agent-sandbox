import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockService } from '../mac/launch-host.mjs';
import { launchService } from '../mac/launch-service.mjs';
import { application, ownedFolder, scenario } from './fixtures/mac-launch.mjs';

test('a lock whose PID now belongs to another process does not block the next gate', t => {
  const folder = ownedFolder(t);
  const lock = join(folder, 'service.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, started: 'Thu Jan  1 00:00:00 1970' }), { mode: 0o600 });
  const release = lockService(folder);
  assert.throws(() => lockService(folder), /already running/);
  release();
  assert.equal(existsSync(lock), false);
});

test('foreign notices and a disabled gate create no offer', async t => {
  const f = scenario(t);
  await f.service.notice({ ...f.notice, author: { id: '777777777777777777' } }, application);
  await f.service.notice({ ...f.notice, channel_id: '777777777777777777' }, application);
  f.source.config.humanDiscord.macLaunchEnabled = false;
  await f.service.notice(f.notice, application);
  assert.equal(f.posted.length, 0);
  assert.equal(f.runs.length, 0);
});

test('one fresh click starts the stored bytes once and delivers the final report', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  assert.equal(f.posted[0].bytes, 'Reply ready.');
  const click = f.press();
  await f.service.press(click);
  await f.service.press(click);
  await launchService(f.dependencies).press(click);
  assert.deepEqual(f.runs, ['Reply ready.']);
  assert.equal(f.store.used(f.request.launch), true);
  await f.service.tick();
  assert.deepEqual(f.edits[0][2].attachments, []);
  assert.deepEqual(f.edits[0][2].components, []);
  assert.deepEqual(f.reports.map(entry => entry.packet.status), ['offered', 'started']);
  f.source.result = { status: 'finished', report: 'ready' };
  await f.service.tick();
  assert.equal(f.reports.at(-1).packet.report, 'ready');
  assert.equal(f.store.get(f.request.launch).state, 'finished');
});

for (const state of ['cancelled', 'superseded', 'expired']) test(`${state} prompts lose their buttons and cannot start`, async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  const click = f.press();
  f.source.state = state;
  f.dependencies.pots.show = async () => ({ ...f.store.get(f.request.launch).request, prompt: 'Reply ready.', state });
  await f.service.tick();
  await f.service.press(click);
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.get(f.request.launch).state, state);
  assert.deepEqual(f.edits.at(-1)[2].attachments, []);
});

test('a changed prompt after display cannot use the displayed approval', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  const click = f.press();
  f.dependencies.pots.show = async () => ({ ...f.request, prompt: 'Different bytes', state: 'open' });
  await f.service.press(click);
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.get(f.request.launch).state, 'superseded');
});

test('a Mac that slept through an approval and a switch disabled after posting never starts', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  const click = f.press();
  f.source.time += 30_001;
  await assert.rejects(f.service.press(click));
  f.source.time -= 30_001;
  f.source.config.humanDiscord.macLaunchEnabled = false;
  await assert.rejects(f.service.press(click));
  assert.equal(f.runs.length, 0);
});

test('failed and uncertain starts consume their approval before they can be retried', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  const click = f.press();
  f.dependencies.runner.start = () => { throw new Error('not started'); };
  await f.service.press(click);
  assert.equal(f.store.used(f.request.launch), true);
  assert.equal(f.store.get(f.request.launch).state, 'failed');
  await launchService(f.dependencies).press(click);
  assert.equal(f.runs.length, 0);
});

test('an exclusive durable consumption survives a crash before the launch state is saved', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  f.store.consume({ launch: f.request.launch });
  await launchService(f.dependencies).press(f.press());
  await f.service.tick();
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.get(f.request.launch).state, 'failed');
  assert.throws(() => f.store.consume({ launch: f.request.launch }));
});

test('refusal is final and failed report delivery retries without another launch', async t => {
  const f = scenario(t);
  await f.service.notice(f.notice, application);
  await f.service.press(f.press('mx'));
  f.source.isReportBroken = true;
  await f.service.tick();
  assert.equal(f.store.get(f.request.launch).pending.length, 2);
  f.source.isReportBroken = false;
  await f.service.tick();
  assert.deepEqual(f.reports.map(entry => entry.packet.status), ['offered', 'refused']);
  assert.equal(f.store.get(f.request.launch).pending.length, 0);
  assert.equal(f.runs.length, 0);
});
