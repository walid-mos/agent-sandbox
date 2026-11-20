import { createHash } from 'node:crypto';
import { expectStatus, GitHubRefusal } from './contribution-api.mjs';
import { nameOf, ownerOf, requireOperation, sameName } from './contribution-policy.mjs';
import { failureReason } from './run.mjs';

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const MAX_TITLE = 256;
const MAX_BODY_BYTES = 65_536;
const refused = message => Object.assign(new Error(`contribute: ${message}`), { exitCode: 2 });

function checkedTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title !== title.trim() || /\p{Cc}/u.test(title) || title.length > MAX_TITLE) {
    throw refused(`a title is one line of visible text, trimmed, up to ${MAX_TITLE} characters.`);
  }
  return title;
}

function checkedBody(body) {
  if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > MAX_BODY_BYTES) throw refused(`a body is nonempty text up to ${MAX_BODY_BYTES} bytes.`);
  return body;
}

function checkedBranch(branch) {
  if (typeof branch !== 'string' || !BRANCH.test(branch) || /\.\.|\/\/|[/.]$|\.lock(?:\/|$)|\/\./u.test(branch)) throw refused(`${JSON.stringify(branch)} is not a plain branch name.`);
  return branch;
}

function checkedCommit(commit, label) {
  if (typeof commit !== 'string' || !FULL_COMMIT.test(commit)) throw refused(`${label} is one full lowercase 40-character commit ID.`);
  return commit;
}

const encodedRef = branch => branch.split('/').map(encodeURIComponent).join('/');
const bodySummary = body => ({ bodySha256: createHash('sha256').update(body).digest('hex'), bodyBytes: Buffer.byteLength(body) });

async function authenticate(api, grant) {
  const user = expectStatus(await api('GET', '/user'), [200], 'read the credential identity');
  const owner = ownerOf(grant.fork);
  if (!sameName(user?.login, owner)) throw refused(`the credential for ${owner} authenticates as ${user?.login}. Fix owners in sandbox.json.`);
  return user.login;
}

async function readUpstream(api, grant) {
  const upstream = expectStatus(await api('GET', `/repos/${grant.upstream}`), [200], `read ${grant.upstream}`);
  if (!sameName(upstream.full_name, grant.upstream) || upstream.private !== false || upstream.archived || upstream.disabled || typeof upstream.default_branch !== 'string') {
    throw refused(`${grant.upstream} is not a public, active repository under that name (GitHub reports ${upstream.full_name}).`);
  }
  return upstream;
}

function isForkOfUpstream(repository, grant) {
  return sameName(repository?.full_name, grant.fork) && repository.fork === true && sameName(repository.parent?.full_name, grant.upstream);
}

async function readFork(api, grant) {
  const response = await api('GET', `/repos/${grant.fork}`);
  if (response.status === 404) return undefined;
  const fork = expectStatus(response, [200], `read ${grant.fork}`);
  if (!isForkOfUpstream(fork, grant) || fork.archived) throw refused(`${grant.fork} is not an active fork of ${grant.upstream} (GitHub reports ${fork.full_name}, parent ${fork.parent?.full_name}).`);
  return fork;
}

async function requireFork(api, grant) {
  const fork = await readFork(api, grant);
  if (!fork) throw refused(`${grant.fork} does not exist. Run the fork operation first.`);
  return fork;
}

async function remoteHead(api, grant, branch) {
  const response = await api('GET', `/repos/${grant.fork}/git/ref/heads/${encodedRef(branch)}`);
  if (response.status === 404) return undefined;
  const ref = expectStatus(response, [200], `read ${branch} on ${grant.fork}`);
  return checkedCommit(ref?.object?.sha, 'the fork branch head GitHub reports');
}

const applyUnlessDryRun = async (plan, dryRun, apply) => (dryRun ? { dryRun: true, plan } : { plan, ...(await apply()) });

function checkPushInputs(branch, commit, expected) {
  checkedBranch(branch);
  checkedCommit(commit, 'the commit');
  if (expected !== undefined) checkedCommit(expected, 'the expected fork branch head');
}

function checkPullRequestInputs({ branch, commit, title, body }) {
  checkedBranch(branch);
  checkedCommit(commit, 'the commit');
  checkedTitle(title);
  checkedBody(body);
}

function requireOwnIssue(created, login, upstream) {
  const isInUpstream = created?.html_url?.startsWith(`https://github.com/${upstream.full_name}/issues/`);
  if (!isInUpstream || !sameName(created.user?.login, login)) {
    throw refused(`GitHub answered with an issue that is not ${login}'s in ${upstream.full_name}: ${created?.html_url}.`);
  }
}

function requireExpectedHead(grant, branch, current, expected) {
  if (current && current !== expected) throw refused(`${grant.fork} already holds ${branch} at ${current}. Inspect it and pass it as the expected head to fast-forward it.`);
}

const isPullRequestAt = (pull, grant, commit) => pull.head?.sha === commit && sameName(pull.head.repo?.full_name, grant.fork);
const isDraftOnBase = (pull, grant, base) => sameName(pull.base?.repo?.full_name, grant.upstream) && pull.base.ref === base && pull.draft === true;

function requireOpenedAsRequested(created, grant, { base }, commit) {
  if (!isPullRequestAt(created, grant, commit) || !isDraftOnBase(created, grant, base)) {
    throw refused(`GitHub opened ${created.html_url} with a different head, base or draft state. Inspect it.`);
  }
}

export function contributionOperations({ api, git, forkUrl }) {
  async function requireBranchAt(grant, branch, commit, advice) {
    const head = await remoteHead(api, grant, branch);
    if (head !== commit) throw refused(`${grant.fork} holds ${branch} at ${head ?? 'nothing'}, not ${commit}. ${advice}`);
  }

  async function requirePushableFork(grant, branch) {
    const upstream = await readUpstream(api, grant);
    const target = await requireFork(api, grant);
    if (target.permissions?.push !== true) throw new GitHubRefusal(`contribute: the credential has no push permission on ${grant.fork}. Ask the operator to grant it. No other credential or route was tried.`, 403);
    if ([upstream.default_branch, target.default_branch].includes(branch)) throw refused(`${branch} is a default branch. Push a topic branch.`);
  }

  function sendPush(grant, { worktree, branch, commit }, current) {
    const destination = { worktree, originUrl: forkUrl(grant.fork), branch };
    try {
      if (current) git.pushUpdate(destination, commit, current);
      else git.pushNew(destination, commit);
    } catch (error) {
      throw refused(`git push to ${grant.fork} failed: ${failureReason(error) || error.message}.`);
    }
  }

  async function ownIssueTitled(grant, login, title) {
    const mine = expectStatus(await api('GET', `/repos/${grant.upstream}/issues?creator=${login}&state=all&per_page=100`), [200], 'list the credential\'s existing issues');
    return mine.find(entry => !entry.pull_request && entry.title === title);
  }

  async function openPullRequestFor(grant, head, commit) {
    const [open] = expectStatus(await api('GET', `/repos/${grant.upstream}/pulls?state=open&head=${encodeURIComponent(head)}`), [200], 'list open pull requests');
    if (!open || isPullRequestAt(open, grant, commit)) return open;
    throw refused(`an open pull request already uses ${head} with another commit: ${open.html_url}.`);
  }

  async function check(grant) {
    const login = await authenticate(api, grant);
    const upstream = await readUpstream(api, grant);
    const fork = await readFork(api, grant);
    return {
      login,
      operations: grant.operations,
      upstream: { full_name: upstream.full_name, default_branch: upstream.default_branch, has_issues: upstream.has_issues },
      fork: fork ? { state: 'ready', full_name: fork.full_name, push: fork.permissions?.push === true } : { state: 'absent', full_name: grant.fork },
    };
  }

  async function fork(grant, { dryRun }) {
    requireOperation(grant, 'fork');
    const login = await authenticate(api, grant);
    await readUpstream(api, grant);
    if (await readFork(api, grant)) return { outcome: 'exists', fork: grant.fork };
    const plan = { operation: 'fork', upstream: grant.upstream, fork: grant.fork, login, defaultBranchOnly: true };
    return applyUnlessDryRun(plan, dryRun, async () => {
      const created = expectStatus(await api('POST', `/repos/${grant.upstream}/forks`, { name: nameOf(grant.fork), default_branch_only: true }), [200, 201, 202], `fork ${grant.upstream}`);
      if (!isForkOfUpstream(created, grant)) throw refused(`GitHub created ${created?.full_name}, not ${grant.fork}. Inspect it before any other step.`);
      return { outcome: 'created', url: created.html_url };
    });
  }

  async function issue(grant, { title, body, dryRun }) {
    requireOperation(grant, 'issue');
    checkedTitle(title);
    checkedBody(body);
    const login = await authenticate(api, grant);
    const upstream = await readUpstream(api, grant);
    if (upstream.has_issues !== true) throw refused(`${grant.upstream} has Issues disabled.`);
    const existing = await ownIssueTitled(grant, login, title);
    if (existing) return { outcome: 'exists', url: existing.html_url };
    const plan = { operation: 'issue', upstream: grant.upstream, login, title, ...bodySummary(body) };
    return applyUnlessDryRun(plan, dryRun, async () => {
      const created = expectStatus(await api('POST', `/repos/${grant.upstream}/issues`, { title, body }), [201], `create an issue in ${grant.upstream}`);
      requireOwnIssue(created, login, upstream);
      return { outcome: 'created', url: created.html_url };
    });
  }

  async function push(grant, { worktree, branch, commit, expect: expected, dryRun }) {
    requireOperation(grant, 'push');
    checkPushInputs(branch, commit, expected);
    const login = await authenticate(api, grant);
    await requirePushableFork(grant, branch);
    if (git.branchHead(worktree, branch) !== commit) throw refused(`the local branch ${branch} is not at ${commit}.`);
    const current = await remoteHead(api, grant, branch);
    if (current === commit) return { outcome: 'current', fork: grant.fork, branch, commit };
    requireExpectedHead(grant, branch, current, expected);
    const plan = { operation: 'push', upstream: grant.upstream, fork: grant.fork, login, branch, commit, remoteHead: current ?? null };
    return applyUnlessDryRun(plan, dryRun, async () => {
      sendPush(grant, { worktree, branch, commit }, current);
      await requireBranchAt(grant, branch, commit, 'Inspect the fork after the push.');
      return { outcome: current ? 'updated' : 'created' };
    });
  }

  async function pullRequest(grant, { branch, commit, title, body, dryRun }) {
    requireOperation(grant, 'pull-request');
    checkPullRequestInputs({ branch, commit, title, body });
    const login = await authenticate(api, grant);
    const upstream = await readUpstream(api, grant);
    await requireFork(api, grant);
    await requireBranchAt(grant, branch, commit, 'Push that commit first.');
    const head = `${ownerOf(grant.fork)}:${branch}`;
    const existing = await openPullRequestFor(grant, head, commit);
    if (existing) return { outcome: 'exists', url: existing.html_url };
    const request = { title, body, head, base: upstream.default_branch, draft: true, maintainer_can_modify: false };
    const plan = { operation: 'pull-request', upstream: grant.upstream, fork: grant.fork, login, base: request.base, head, commit, draft: true, title, ...bodySummary(body) };
    return applyUnlessDryRun(plan, dryRun, async () => {
      const created = expectStatus(await api('POST', `/repos/${grant.upstream}/pulls`, request), [201], `open a pull request in ${grant.upstream}`);
      requireOpenedAsRequested(created, grant, request, commit);
      return { outcome: 'created', url: created.html_url };
    });
  }

  return { check, fork, issue, push, 'pull-request': pullRequest };
}
