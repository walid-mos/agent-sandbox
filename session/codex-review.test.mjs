import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkReviewedSource, reviewAdmission, sha256, SOURCE_PARENT } from './codex-review.mjs';

function review() {
  const scope = { contract: 'CODEX_TARGETED_V1', claude: 'DEFERRED', applicationRequests: 6,
    pots: ['accor', 'mastermind', 'nextnode', 'personal'], recoveryPot: 'nextnode', manifestSha256: 'fixture',
    routes: Object.fromEntries(['mac', 'accor', 'mastermind', 'nextnode', 'personal', 'nextnodeRecovery'].map(machine => [machine, 'codex/gpt-6.2-sol:high#original'])),
    routerEndpoints: Object.fromEntries(['mac', 'accor', 'mastermind', 'nextnode', 'personal'].map(machine => [machine, 'http://127.0.0.1:3425/v1'])),
    source: { allowedCommits: ['fixture'] },
    window: { notBefore: '2026-11-20T00:00:00Z', admitUntil: '2026-11-20T02:00:00Z', recoveryReserveSeconds: 1800, minimumStartSeconds: 1800 } };
  const receipt = { state: 'ACCEPTED', scopeSha256: sha256(JSON.stringify(scope)), evidence: 'SYNTHETIC fixture only', at: '2026-11-19T23:00:00Z' };
  return { scope, parentApproval: { ...receipt }, operatorApproval: { ...receipt } };
}
const now = Date.parse('2026-11-20T00:01:00Z');

test('exact synthetic parent and operator receipts admit only their reviewed window', () => {
  assert.equal(reviewAdmission(review(), now).claude, 'DEFERRED');
  const candidate = review();
  candidate.scope.applicationRequests = 7;
  assert.throws(() => reviewAdmission(candidate, now), /refused/u);
  assert.throws(() => reviewAdmission(review(), Date.parse('2026-11-21T13:00:00Z')), /window/u);
});

test('absent, changed or future approval never becomes permission when Claude reset time passes', () => {
  const candidate = review();
  candidate.parentApproval.state = 'PROPOSED';
  assert.throws(() => reviewAdmission(candidate, now), /parentApproval/u);
  candidate.parentApproval = { ...candidate.operatorApproval, at: '2026-11-21T13:00:00Z' };
  assert.throws(() => reviewAdmission(candidate, now), /parentApproval/u);
});

test('owned Git fixture rejects dirty paths, wrong origin and an unreviewed commit delta', t => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = arguments_ => execFileSync('git', ['-C', directory, ...arguments_], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'fixture']);
  git(['fetch', '--no-tags', resolve('.'), 'HEAD']);
  git(['reset', '--hard', 'FETCH_HEAD']);
  git(['remote', 'add', 'origin', 'https://github.com/walid-mos/agent-sandbox.git']);
  const tip = git(['rev-parse', 'HEAD']);
  const source = { parent: SOURCE_PARENT, tip, branch: 'fixture', origin: 'https://github.com/walid-mos/agent-sandbox.git', allowedCommits: git(['rev-list', '--reverse', `${SOURCE_PARENT}..${tip}`]).split('\n') };
  assert.equal(checkReviewedSource(source, directory).isExactSource, true);
  assert.throws(() => checkReviewedSource({ ...source, allowedCommits: [] }, directory), /commit delta/u);
  writeFileSync(join(directory, 'untracked'), 'fixture');
  assert.throws(() => checkReviewedSource(source, directory), /dirty/u);
  git(['remote', 'set-url', 'origin', 'https://example.invalid/wrong.git']);
  assert.throws(() => checkReviewedSource(source, directory), /origin drift/u);
  git(['config', 'core.fsmonitor', `touch ${join(directory, 'planted')}`]);
  assert.throws(() => checkReviewedSource(source, directory), /command configuration/u);
});
