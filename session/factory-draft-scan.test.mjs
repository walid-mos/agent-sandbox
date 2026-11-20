import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const repository = 'example/fixture';
const principal = 'principal';
const scratch = mkdtempSync(join(tmpdir(), 'factory-draft-scan-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
process.env.HOME = scratch;

const candidate = { number: 37, isDraft: true, createdAt: '2026-11-17T12:00:00Z' };
const facts = {
  ...candidate, state: 'OPEN', isCrossRepository: false, headRefName: 'feat/fixture',
  headRefOid: 'a'.repeat(40), lastEditedAt: null, title: 'Draft title', body: 'PRIVATE FIXTURE BODY',
};
const worker = { name: 'fixture', repository, branch: facts.headRefName, owner: 'nextnode' };
const wakeCalls = [];
let current;
let isDraft;

const page = (...nodes) => ({ data: { repository: { pullRequests: { nodes } } } });
function github(args, options) {
  if (args[0] === 'repo') return [{ nameWithOwner: repository, repositoryTopics: [{ name: 'factory' }] }];
  if (args.slice(0, 2).join(' ') === 'pr list') return [{ ...candidate, isDraft }];
  return githubGraphql(args, options);
}

function githubGraphql(args, options) {
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
  assert.equal(options.env.GH_REPO, repository);
  if (args.includes('--paginate')) return [page({ ...candidate, isDraft: false }), page(candidate)];
  assert.ok(args.includes('number=37'));
  return { data: { repository: { pullRequest: current } } };
}

mock.module('./sandbox.mjs', { exports: { botId: principal, owners: ['example'], sandbox: {} } });
mock.module('./run.mjs', { exports: {
  WITH_VAULT: '/unused-vault',
  command(binary, args, options) {
    if (binary === 'gh') return JSON.stringify(github(args, options));
    assert.equal(binary, 'pots');
    const [operation, botFlag, bot, fromFlag, from, idFlag, id, noteFlag, note] = args;
    assert.deepEqual([operation, botFlag, fromFlag, idFlag, noteFlag], ['wake', '--bot', '--from', '--id', '--note']);
    wakeCalls.push({ bot, from, id, note });
  },
} });
const { discoverReady, scan } = await import('./factory-scan.mjs');
const { save, WORKERS } = await import('./workers.mjs');
const { recordedHeads } = await import('./factory-records.mjs');

beforeEach(({ mock }) => {
  rmSync(WORKERS, { recursive: true, force: true });
  wakeCalls.length = 0;
  current = facts;
  isDraft = true;
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-19T12:00:00Z') });
});

test('discovery rechecks unknown mergeability within the same wake', async () => {
  isDraft = false;
  const subject = { repository, number: 37, mergeable: 'MERGEABLE' };
  const observed = [];
  const read = mock.fn(() => subject);
  read.mock.mockImplementationOnce(() => ({ ...subject, mergeable: 'UNKNOWN' }));
  const wait = mock.fn(async () => assert.deepEqual(observed, []));
  await discoverReady({ observe: pull => observed.push(pull) }, [repository], read, wait);
  assert.deepEqual(wait.mock.calls.map(call => call.arguments), [[5000]]);
  assert.equal(read.mock.callCount(), 2);
  assert.deepEqual(observed, [subject]);
});

test('the periodic scan wakes the recorded owner for an old draft found on a later page', async () => {
  save({ ...worker, repository: 'Example/Fixture' });
  await scan({ routine: 1 });
  await scan({ routine: 1 });
  assert.equal(wakeCalls.length, 2);
  assert.deepEqual(wakeCalls.map(wake => wake.bot), ['nextnode', 'nextnode']);
  assert.equal(wakeCalls[0].from, 'pr-factory');
  assert.match(wakeCalls[0].id, /^pr-factory-stale-draft-[0-9a-f]{64}$/);
  assert.equal(wakeCalls[0].id, wakeCalls[1].id);
  assert.match(wakeCalls[0].note, /https:\/\/github\.com\/example\/fixture\/pull\/37/);
  assert.doesNotMatch(wakeCalls[0].note, /PRIVATE FIXTURE BODY|Draft title/);
  assert.deepEqual(recordedHeads(), []);
});

for (const [requirement, fixture, records] of [
  ['no worker record', facts, []],
  ['a worker for a different branch', facts, [{ ...worker, branch: 'feat/other' }]],
  ['a fork with the same branch name', { ...facts, isCrossRepository: true }, [worker]],
  ['a worker linked to a different pull request', facts, [{ ...worker, pullRequest: `https://github.com/${repository}/pull/38` }]],
]) {
  test(`the scan wakes this sandbox's bot when there is ${requirement}`, async () => {
    current = fixture;
    records.forEach(save);
    await scan({ routine: 1 });
    assert.deepEqual(wakeCalls.map(wake => wake.bot), [principal]);
  });
}

test('the scan rereads new body text and skips a draft that became ready or closed', async () => {
  current = { ...facts, body: 'BLOCKED UNTIL: 2026-11-20 — Waiting for access' };
  await scan({ routine: 1 });
  assert.deepEqual(wakeCalls, []);
  current = facts;
  await scan({ routine: 1 });
  assert.equal(wakeCalls.length, 1);
  current = { ...facts, isDraft: false };
  await scan({ routine: 1 });
  current = { ...facts, state: 'CLOSED' };
  await scan({ routine: 1 });
  assert.equal(wakeCalls.length, 1);
});
