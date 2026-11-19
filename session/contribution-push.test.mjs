import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubApi } from './contribution-api.mjs';
import { contributionOperations } from './contribution-operations.mjs';
import { contributionPolicy } from './contribution-policy.mjs';
import { pushApproved, pushExisting } from './push-approved.mjs';

const [GRANT] = contributionPolicy({
  owners: { 'walid-mos': 'GITHUB_TOKEN_WALID_MOS' },
  contributions: { 'Crokily/pi-durable-bot': { fork: 'walid-mos/pi-durable-bot', operations: ['push'] } },
});
const BRANCH = 'feat/graceful-restart';
const ACCESS = { helper: '', env: {} };
const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

const git = (directory, ...arguments_) => execFileSync('git', ['-C', directory, '-c', 'commit.gpgsign=false', ...arguments_], { encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();

function scenario(t) {
  const root = mkdtempSync(join(tmpdir(), 'contribution-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fork = join(root, 'fork.git');
  const worktree = join(root, 'checkout');
  mkdirSync(worktree);
  execFileSync('git', ['init', '--quiet', '--bare', fork]);
  git(worktree, 'init', '--quiet', '-b', BRANCH);
  const marker = join(root, 'hook-ran');
  writeFileSync(join(worktree, '.git/hooks/pre-push'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const commit = message => {
    writeFileSync(join(worktree, 'file.txt'), message);
    git(worktree, 'add', 'file.txt');
    git(worktree, 'commit', '--quiet', '-m', message);
    return git(worktree, 'rev-parse', 'HEAD');
  };
  const forkHead = () => (existsSync(join(fork, 'refs/heads', BRANCH)) ? git(fork, 'rev-parse', `refs/heads/${BRANCH}`) : undefined);
  const upstream = { full_name: 'Crokily/pi-durable-bot', private: false, archived: false, disabled: false, default_branch: 'main' };
  const repository = { full_name: 'walid-mos/pi-durable-bot', fork: true, default_branch: 'main', parent: { full_name: 'Crokily/pi-durable-bot' }, permissions: { push: true } };
  const api = async (_method, path) => {
    if (path === '/user') return { status: 200, data: { login: 'walid-mos' } };
    if (path === '/repos/Crokily/pi-durable-bot') return { status: 200, data: upstream };
    if (path.includes('/git/ref/heads/')) return forkHead() ? { status: 200, data: { object: { sha: forkHead() } } } : { status: 404, data: null };
    return { status: 200, data: repository };
  };
  const operations = contributionOperations({
    api,
    git: {
      branchHead: (directory, branch) => git(directory, 'rev-parse', `refs/heads/${branch}`),
      pushNew: (destination, head) => pushApproved(destination, head, ACCESS),
      pushUpdate: (destination, head, expected) => pushExisting(destination, head, expected, ACCESS),
    },
    forkUrl: () => fork,
  });
  return { operations, worktree, commit, forkHead, marker };
}

test('push lands exactly the named commit on the fork and runs no checkout hook', async t => {
  const { operations, worktree, commit, forkHead, marker } = scenario(t);
  const first = commit('first');
  assert.equal((await operations.push(GRANT, { worktree, branch: BRANCH, commit: first })).outcome, 'created');
  assert.equal(forkHead(), first);
  assert.equal(existsSync(marker), false);
});

test('a fast-forward needs the expected head and never rewrites history', async t => {
  const { operations, worktree, commit, forkHead } = scenario(t);
  const first = commit('first');
  await operations.push(GRANT, { worktree, branch: BRANCH, commit: first });
  const second = commit('second');
  await assert.rejects(operations.push(GRANT, { worktree, branch: BRANCH, commit: second }), /already holds/u);
  assert.equal(forkHead(), first);
  assert.equal((await operations.push(GRANT, { worktree, branch: BRANCH, commit: second, expect: first })).outcome, 'updated');
  assert.equal(forkHead(), second);
  git(worktree, 'reset', '--quiet', '--hard', first);
  const diverged = commit('diverged');
  await assert.rejects(operations.push(GRANT, { worktree, branch: BRANCH, commit: diverged, expect: second }), /git push to walid-mos\/pi-durable-bot failed/u);
  assert.equal(forkHead(), second);
});

test('the API client sends the credential to api.github.com only and never follows a redirect', async () => {
  const seen = [];
  const redirecting = async (url, init) => {
    seen.push({ url, redirect: init.redirect, authorization: init.headers.Authorization });
    return new Response('', { status: 301, headers: { location: 'https://evil.example/' } });
  };
  const response = await githubApi('fake-token', redirecting)('GET', '/repos/Crokily/pi-durable-bot');
  assert.equal(response.status, 301);
  assert.deepEqual(seen, [{ url: 'https://api.github.com/repos/Crokily/pi-durable-bot', redirect: 'manual', authorization: 'Bearer fake-token' }]);
});
