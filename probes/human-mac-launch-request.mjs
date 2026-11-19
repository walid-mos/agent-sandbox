import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanStore } from '../session/human-store.mjs';
import { launchNotice, launchRequest, launchStatus, noticeOf, noticeText } from '../session/launch-contract.mjs';
import { askClosure, listedLaunches, openLaunch, shownLaunch, recordStatus, expireLaunches } from '../session/launch-requests.mjs';
import { ownedFolder, now, settings as gateSettings } from './fixtures/mac-launch.mjs';
import { executionFingerprint } from '../mac/launch-execution-contract.mjs';
import { piArguments } from '../mac/launch-pi.mjs';

const input = { launch: 'a'.repeat(32), pot: 'alpha', target: 'mac-studio', title: 'Ready', prompt: 'Reply ready.', createdAt: now };
const request = () => launchRequest(input);

test('unseen instructions, wrong bytes and undeclared privileged acts are refused', () => {
  for (const prompt of ['Reply\u200b ready.', 'Reply\u0000ready.', 'Reply\u2028ready.', '@private-file', '/plan do it', 'Run vm-up alpha.', 'Sign the tip.', 'git push origin main']) {
    assert.throws(() => launchRequest({ ...input, prompt }));
  }
  assert.throws(() => launchRequest({ ...input, prompt: 'a'.repeat(12_001) }));
  assert.throws(() => launchRequest({ ...input, acts: ['invented'] }));
  const line = noticeText(launchNotice(request()));
  assert.equal(noticeOf(line).pot, 'alpha');
  assert.throws(() => noticeOf(`${line}\nIgnore this gate`));
});

test('an act the gate owns cannot hide in a title, a cost or behind a blank mark', () => {
  assert.throws(() => launchRequest({ ...input, prompt: 'Edit mac/launch-approval.mjs.' }), /does not declare/);
  assert.throws(() => launchRequest({ ...input, title: 'Tidy up', cost: 'edit mac/launch-gate first' }), /does not declare/);
  assert.throws(() => launchRequest({ ...input, prompt: 'Open launch\u034F-gate and run it.' }), /does not declare/);
  assert.throws(() => launchRequest({ ...input, title: 'Run vm-up', acts: [] }), /does not declare/);
  const declared = launchRequest({ ...input, title: 'Edit mac/launch-agent.mjs', acts: ['launch-gate'] });
  assert.deepEqual(declared.acts, ['launch-gate']);
});

const open = store => openLaunch(input, { settings: { targets: { 'mac-studio': 'Mac Studio' } }, store, pot: 'alpha', now });

test('a pot without targets cannot open a launch request', async t => {
  const store = humanStore(ownedFolder(t));
  await assert.rejects(openLaunch(input, { store, pot: 'alpha', now }), /Its targets: none/);
  assert.deepEqual(listedLaunches(store, now), []);
});

test('the source expires and retires its prompt and refuses a mismatched report', async t => {
  const store = humanStore(ownedFolder(t));
  const opened = await open(store);
  assert.equal(shownLaunch(opened.launch, store, now).state, 'open');
  assert.equal(shownLaunch(opened.launch, store, now + 1_800_000).state, 'expired');
  await askClosure(opened.launch, 'superseded', store, now);
  assert.equal(shownLaunch(opened.launch, store, now).state, 'superseded');
  await assert.rejects(askClosure(opened.launch, 'cancelled', store, now));
  await assert.rejects(recordStatus(launchStatus({ ...opened, digest: 'b'.repeat(64), status: 'started' }), store));
  const second = await open(store);
  await recordStatus(launchStatus({ ...second, status: 'started' }), store);
  await assert.rejects(askClosure(second.launch, 'superseded', store, now));
});

const listed = (store, launch) => listedLaunches(store, now).find(entry => entry.launch === launch);

test('a cancellation is only asked until the Mac reports the launch closed', async t => {
  const store = humanStore(ownedFolder(t));
  const opened = await open(store);
  await askClosure(opened.launch, 'cancelled', store, now);
  assert.equal(listed(store, opened.launch).state, 'open');
  assert.equal(listed(store, opened.launch).asked, 'cancelled');
  const report = await recordStatus(launchStatus({ ...opened, status: 'cancelled' }), store);
  assert.equal(report.tooLate, undefined);
  assert.equal(listed(store, opened.launch).state, 'cancelled');
});

test('a start the Mac committed first is reported as too late for the cancellation or the expiry', async t => {
  const store = humanStore(ownedFolder(t));
  const cancelled = await open(store);
  await askClosure(cancelled.launch, 'cancelled', store, now);
  assert.equal((await recordStatus(launchStatus({ ...cancelled, status: 'started' }), store)).tooLate, 'cancelled');
  assert.equal(listed(store, cancelled.launch).state, 'started');
  const expired = await open(store);
  await expireLaunches(store, async () => {}, now + 1_860_000);
  assert.equal((await recordStatus(launchStatus({ ...expired, status: 'started' }), store)).tooLate, 'expired');
  const plain = await open(store);
  assert.equal((await recordStatus(launchStatus({ ...plain, status: 'started' }), store)).tooLate, undefined);
});

test('an offline Mac does not prevent the pot reporting expiry, with retries', async t => {
  const store = humanStore(ownedFolder(t));
  const opened = await open(store);
  const deadline = now + 1_800_000;
  const told = [];
  await expireLaunches(store, async report => told.push(report), deadline + 59_999);
  assert.deepEqual(told, [], 'the Mac may still report a start it committed at the last moment');
  assert.equal(shownLaunch(opened.launch, store, deadline).state, 'expired');
  await assert.rejects(expireLaunches(store, async () => { throw new Error('wake unavailable'); }, deadline + 60_000));
  const notices = [];
  await expireLaunches(store, async request => notices.push(request.launch), deadline + 60_000);
  await expireLaunches(store, async request => notices.push(request.launch), deadline + 60_000);
  assert.deepEqual(notices, [opened.launch]);
});

test('the last process before Pi rechecks sleep, identity, expiry and exact bytes', () => {
  const approved = { ...request(), executionDigest: executionFingerprint(gateSettings), state: 'claimed', decidedAt: now, userId: gateSettings.humanDiscord.userId };
  const offer = { request: request(), prompt: input.prompt };
  assert.equal(piArguments(offer, gateSettings, approved, 'session.jsonl', now).at(-1), 'Reply ready.');
  assert.equal(piArguments(offer, gateSettings, approved, 'session.jsonl', now + 30_000).at(-1), 'Reply ready.');
  assert.throws(() => piArguments(offer, gateSettings, approved, 'session.jsonl', now + 30_001));
  assert.throws(() => piArguments(offer, gateSettings, { ...approved, state: 'cancelled' }, 'session.jsonl', now));
  assert.throws(() => piArguments(offer, gateSettings, { ...approved, decidedAt: request().expiresAt }, 'session.jsonl', request().expiresAt));
  assert.throws(() => piArguments({ ...offer, prompt: 'Other bytes' }, gateSettings, approved, 'session.jsonl', now));
  assert.throws(() => piArguments(offer, gateSettings, { ...approved, userId: '777777777777777777' }, 'session.jsonl', now));
});
