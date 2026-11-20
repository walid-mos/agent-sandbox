import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contributionOperations } from './contribution-operations.mjs';
import { contributionPolicy } from './contribution-policy.mjs';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const [GRANT] = contributionPolicy({
  owners: { 'walid-mos': 'GITHUB_TOKEN_WALID_MOS' },
  contributions: { 'Crokily/pi-durable-bot': { fork: 'walid-mos/pi-durable-bot', operations: ['fork', 'issue', 'push', 'pull-request'] } },
});
const UPSTREAM = { full_name: 'Crokily/pi-durable-bot', private: false, archived: false, disabled: false, default_branch: 'main', has_issues: true };
const FORK = { full_name: 'walid-mos/pi-durable-bot', fork: true, archived: false, default_branch: 'main', parent: { full_name: 'Crokily/pi-durable-bot' }, permissions: { push: true } };

function fakeGitHub(overrides = {}) {
  const state = { login: 'walid-mos', upstream: UPSTREAM, fork: FORK, refs: {}, issues: [], pulls: [], refusals: {}, ...overrides };
  const writes = [];
  const routes = [
    ['GET', /^\/user$/u, () => [200, { login: state.login }]],
    ['GET', /^\/repos\/Crokily\/pi-durable-bot$/u, () => [200, state.upstream]],
    ['GET', /^\/repos\/walid-mos\/pi-durable-bot$/u, () => (state.fork ? [200, state.fork] : [404, { message: 'Not Found' }])],
    ['GET', /^\/repos\/walid-mos\/pi-durable-bot\/git\/ref\/heads\/(.+)$/u, ([, branch]) => (state.refs[branch] ? [200, { object: { sha: state.refs[branch] } }] : [404, null])],
    ['GET', /\/issues\?/u, () => [200, state.issues]],
    ['GET', /\/pulls\?/u, () => [200, state.pulls]],
    ['POST', /\/forks$/u, body => { state.fork = FORK; return [202, { ...FORK, html_url: 'https://github.com/walid-mos/pi-durable-bot', name: body.name }]; }],
    ['POST', /\/issues$/u, body => [201, { html_url: 'https://github.com/Crokily/pi-durable-bot/issues/1', user: { login: state.login }, ...body }]],
    ['POST', /\/pulls$/u, body => [201, {
      html_url: 'https://github.com/Crokily/pi-durable-bot/pull/2', draft: body.draft, base: { ref: body.base, repo: { full_name: 'Crokily/pi-durable-bot' } },
      head: { sha: state.refs[body.head.split(':')[1]], repo: { full_name: 'walid-mos/pi-durable-bot' } },
    }]],
  ];
  const api = async (method, path, body) => {
    if (method !== 'GET') writes.push({ method, path, body });
    const refusal = state.refusals[`${method} ${path}`];
    if (refusal) return { status: refusal, data: { message: 'Resource not accessible by personal access token' } };
    for (const [routeMethod, pattern, answer] of routes) {
      const match = routeMethod === method && pattern.exec(path);
      if (!match) continue;
      // A GET handler may read the route match, and an empty body is a valid answer.
      const answered = method === 'GET' ? answer(match) : answer(body);
      return { status: answered[0], data: answered[1] };
    }
    return { status: 500, data: { message: `unrouted ${method} ${path}` } };
  };
  const pushes = [];
  const git = {
    branchHead: () => state.localHead ?? COMMIT,
    pushNew: ({ branch }, commit) => { pushes.push(['new', branch, commit]); state.refs[branch] = commit; },
    pushUpdate: ({ branch }, commit, expected) => { pushes.push(['update', branch, commit, expected]); state.refs[branch] = commit; },
  };
  const operations = contributionOperations({ api, git, forkUrl: name => `https://github.com/${name}.git` });
  return { operations, state, writes, pushes };
}

const ISSUE = { title: 'Add a graceful gateway restart', body: 'Body text', dryRun: false };
const PUSH = { worktree: '/unused', branch: 'feat/graceful-restart', commit: COMMIT, dryRun: false };
const PULL_REQUEST = { branch: 'feat/graceful-restart', commit: COMMIT, title: 'feat: graceful restart', body: 'Body', dryRun: false };

test('check reports an absent fork and writes nothing', async () => {
  const { operations, writes } = fakeGitHub({ fork: null });
  const report = await operations.check(GRANT);
  assert.deepEqual(report.fork, { state: 'absent', full_name: 'walid-mos/pi-durable-bot' });
  assert.deepEqual(writes, []);
});

test('fork creates only the default branch under the policy name', async () => {
  const { operations, writes } = fakeGitHub({ fork: null });
  const result = await operations.fork(GRANT, { dryRun: false });
  assert.equal(result.outcome, 'created');
  assert.deepEqual(writes, [{ method: 'POST', path: '/repos/Crokily/pi-durable-bot/forks', body: { name: 'pi-durable-bot', default_branch_only: true } }]);
});

test('fork leaves an existing fork alone', async () => {
  const { operations, writes } = fakeGitHub();
  assert.equal((await operations.fork(GRANT, { dryRun: false })).outcome, 'exists');
  assert.deepEqual(writes, []);
});

test('a dry run plans the write and sends none', async () => {
  const { operations, writes } = fakeGitHub({ fork: null });
  const result = await operations.fork(GRANT, { dryRun: true });
  assert.equal(result.plan.login, 'walid-mos');
  assert.deepEqual(writes, []);
});

test('a credential that authenticates as another account writes nothing', async () => {
  const { operations, writes } = fakeGitHub({ login: 'someone-else', fork: null });
  await assert.rejects(operations.fork(GRANT, { dryRun: false }), /authenticates as someone-else/u);
  assert.deepEqual(writes, []);
});

test('a fork whose parent is another repository is refused', async () => {
  const { operations, writes } = fakeGitHub({ fork: { ...FORK, parent: { full_name: 'Other/pi-durable-bot' } } });
  await assert.rejects(operations.push(GRANT, PUSH), /not an active fork of Crokily\/pi-durable-bot/u);
  assert.deepEqual(writes, []);
});

test('an issue opens in the upstream with the exact title and body', async () => {
  const { operations, writes } = fakeGitHub();
  const result = await operations.issue(GRANT, ISSUE);
  assert.equal(result.url, 'https://github.com/Crokily/pi-durable-bot/issues/1');
  assert.deepEqual(writes, [{ method: 'POST', path: '/repos/Crokily/pi-durable-bot/issues', body: { title: ISSUE.title, body: ISSUE.body } }]);
});

test('a retried issue with the same title files nothing new', async () => {
  const { operations, writes } = fakeGitHub({ issues: [{ title: ISSUE.title, html_url: 'https://github.com/Crokily/pi-durable-bot/issues/9' }] });
  assert.deepEqual(await operations.issue(GRANT, ISSUE), { outcome: 'exists', url: 'https://github.com/Crokily/pi-durable-bot/issues/9' });
  assert.deepEqual(writes, []);
});

test('a pull request listed among issues does not count as the issue', async () => {
  const { operations } = fakeGitHub({ issues: [{ title: ISSUE.title, pull_request: {}, html_url: 'x' }] });
  assert.equal((await operations.issue(GRANT, ISSUE)).outcome, 'created');
});

test('an issue is refused when Issues are disabled or the upstream is archived', async () => {
  for (const upstream of [{ ...UPSTREAM, has_issues: false }, { ...UPSTREAM, archived: true }, { ...UPSTREAM, private: true }]) {
    const { operations, writes } = fakeGitHub({ upstream });
    await assert.rejects(operations.issue(GRANT, ISSUE));
    assert.deepEqual(writes, []);
  }
});

test('a title with a line break is refused', async () => {
  const { operations } = fakeGitHub();
  await assert.rejects(operations.issue(GRANT, { ...ISSUE, title: 'one\ntwo' }), /one line/u);
});

test('GitHub withholding permission surfaces as exit 3 with no second attempt', async () => {
  const { operations, writes } = fakeGitHub({ refusals: { 'POST /repos/Crokily/pi-durable-bot/issues': 403 } });
  await assert.rejects(operations.issue(GRANT, ISSUE), error => error.exitCode === 3 && /HTTP 403/u.test(error.message) && /No other credential or route was tried/u.test(error.message));
  assert.equal(writes.length, 1);
});

test('push publishes a new branch and verifies the fork readback', async () => {
  const { operations, pushes } = fakeGitHub();
  assert.equal((await operations.push(GRANT, PUSH)).outcome, 'created');
  assert.deepEqual(pushes, [['new', 'feat/graceful-restart', COMMIT]]);
});

test('push refuses a branch that is not at the named commit', async () => {
  const { operations, pushes } = fakeGitHub({ localHead: OTHER_COMMIT });
  await assert.rejects(operations.push(GRANT, PUSH), /is not at a{40}/u);
  assert.deepEqual(pushes, []);
});

test('push refuses default branches and abbreviated commits', async () => {
  const { operations, pushes } = fakeGitHub();
  await assert.rejects(operations.push(GRANT, { ...PUSH, branch: 'main' }), /default branch/u);
  await assert.rejects(operations.push(GRANT, { ...PUSH, commit: 'aaaaaaa' }), /full lowercase/u);
  await assert.rejects(operations.push(GRANT, { ...PUSH, branch: '../escape' }), /plain branch name/u);
  assert.deepEqual(pushes, []);
});

test('push refuses a fork branch that moved unless its head is expected', async () => {
  const { operations, pushes } = fakeGitHub({ refs: { 'feat/graceful-restart': OTHER_COMMIT } });
  await assert.rejects(operations.push(GRANT, PUSH), /already holds feat\/graceful-restart at b{40}/u);
  assert.deepEqual(pushes, []);
  assert.equal((await operations.push(GRANT, { ...PUSH, expect: OTHER_COMMIT })).outcome, 'updated');
  assert.deepEqual(pushes, [['update', 'feat/graceful-restart', COMMIT, OTHER_COMMIT]]);
});

test('push is a no-op when the fork already holds the commit', async () => {
  const { operations, pushes } = fakeGitHub({ refs: { 'feat/graceful-restart': COMMIT } });
  assert.equal((await operations.push(GRANT, PUSH)).outcome, 'current');
  assert.deepEqual(pushes, []);
});

test('push without push permission on the fork surfaces as exit 3', async () => {
  const { operations, pushes } = fakeGitHub({ fork: { ...FORK, permissions: { push: false } } });
  await assert.rejects(operations.push(GRANT, PUSH), error => error.exitCode === 3);
  assert.deepEqual(pushes, []);
});

test('a pull request opens as a draft from the verified fork branch', async () => {
  const { operations, writes } = fakeGitHub({ refs: { 'feat/graceful-restart': COMMIT } });
  const result = await operations['pull-request'](GRANT, PULL_REQUEST);
  assert.equal(result.url, 'https://github.com/Crokily/pi-durable-bot/pull/2');
  assert.deepEqual(writes.map(write => write.body), [{
    title: PULL_REQUEST.title, body: 'Body', head: 'walid-mos:feat/graceful-restart', base: 'main', draft: true, maintainer_can_modify: false,
  }]);
});

test('a pull request refuses a fork branch at another commit', async () => {
  const { operations, writes } = fakeGitHub({ refs: { 'feat/graceful-restart': OTHER_COMMIT } });
  await assert.rejects(operations['pull-request'](GRANT, PULL_REQUEST), /Push that commit first/u);
  assert.deepEqual(writes, []);
});

test('a pull request refuses a branch nobody pushed', async () => {
  const { operations } = fakeGitHub();
  await assert.rejects(operations['pull-request'](GRANT, PULL_REQUEST), /holds feat\/graceful-restart at nothing/u);
});

test('an open pull request for the same head is reused, and one at another commit is refused', async () => {
  const open = { html_url: 'https://github.com/Crokily/pi-durable-bot/pull/7', head: { sha: COMMIT, repo: { full_name: 'walid-mos/pi-durable-bot' } } };
  const same = fakeGitHub({ refs: { 'feat/graceful-restart': COMMIT }, pulls: [open] });
  assert.equal((await same.operations['pull-request'](GRANT, PULL_REQUEST)).outcome, 'exists');
  assert.deepEqual(same.writes, []);
  const moved = fakeGitHub({ refs: { 'feat/graceful-restart': COMMIT }, pulls: [{ ...open, head: { ...open.head, sha: OTHER_COMMIT } }] });
  await assert.rejects(moved.operations['pull-request'](GRANT, PULL_REQUEST), /another commit/u);
});

test('an operation the grant omits is refused before any request', async () => {
  const [limited] = contributionPolicy({ owners: { 'walid-mos': 'T' }, contributions: { 'Crokily/pi-durable-bot': { fork: 'walid-mos/pi-durable-bot', operations: ['issue'] } } });
  const { operations, writes } = fakeGitHub();
  await assert.rejects(operations.fork(limited, { dryRun: false }), /does not permit fork/u);
  await assert.rejects(operations['pull-request'](limited, PULL_REQUEST), /does not permit pull-request/u);
  assert.deepEqual(writes, []);
});
