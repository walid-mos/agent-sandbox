import { ACCOR_FIRST_PUBLICATION, accorPublicationPolicy } from './accor-publication-policy.mjs';
import { openReadyPR, verifyPublishedPR } from './accor-pull-request.mjs';
import { consumeDiscordPush, verifyConsumedDiscordPush } from './human-consume.mjs';
import { humanStore } from './human-store.mjs';
import { isFullObjectId, pushApproved, pushExisting, remoteHead } from './push-approved.mjs';
import { command } from './run.mjs';
import { repositoryOrigin } from './repository-origin.mjs';
import { botId, sandbox } from './sandbox.mjs';
import { lockWorkerPublication } from './worker-publication-lock.mjs';
import { ownedWorker, PUBLICATION, recordPublication } from './workers.mjs';

const AFFIRMATIVE_LABEL = 'Push once';
const DECLINE_LABEL = 'Keep local';

function repositoryWorker(name) {
  const worker = ownedWorker(name, botId);
  if (!worker?.repository || worker.kind === 'task') throw new Error('dispatch: publication requires an owned repository worker.');
  return worker;
}

const isAccorWorker = worker => worker.publicationPolicy === ACCOR_FIRST_PUBLICATION;
const gitFor = worker => args => command('git', args, { cwd: worker.worktree });

function checkCheckout(worker, git) {
  if (git(['branch', '--show-current']) !== worker.branch) throw new Error('dispatch: task branch changed. Restore it before publication.');
  if (!worker.originUrl || git(['remote', 'get-url', 'origin']) !== worker.originUrl) throw new Error('dispatch: origin changed. Restore it and ask for a new approval.');
  if (git(['remote', 'get-url', '--push', '--all', 'origin']) !== worker.originUrl) throw new Error('dispatch: push destination differs from the approved origin. Restore it before asking for approval.');
  if (git(['status', '--porcelain'])) throw new Error('dispatch: commit or remove local changes before requesting publication.');
}

function checkLocal(worker, git) {
  if (worker.publication !== PUBLICATION.local) throw new Error('dispatch: this worker is not waiting for its first approved push. Use open-pr after a successful push.');
  checkCheckout(worker, git);
}

function newCommits(worker, git) {
  git(['fetch', '--quiet', 'origin', worker.base]);
  const baseCommit = git(['rev-parse', `refs/remotes/origin/${worker.base}`]);
  const head = git(['rev-parse', 'HEAD']);
  if (git(['merge-base', baseCommit, head]) !== baseCommit) throw new Error('dispatch: the branch no longer contains the fresh base. Inspect it before publication.');
  const commits = git(['rev-list', '--reverse', `${baseCommit}..${head}`]).split('\n').filter(Boolean);
  if (!commits.length) throw new Error('dispatch: first publication needs at least one commit above the fresh base.');
  return { baseCommit, head, commits };
}

function scopeFor(worker, { baseCommit, head, commits }) {
  return JSON.stringify({ operation: 'first-worker-push', repository: worker.repository, branch: worker.branch,
    remote: 'origin', url: worker.originUrl, base: worker.base, baseCommit, commits, head,
    ...(isAccorWorker(worker) ? { publicationPolicy: worker.publicationPolicy, readyTitle: worker.title } : { draftTitle: worker.title }) });
}

function firstPush(worker, git) {
  if (remoteHead(worker)) throw new Error('dispatch: the remote task branch already exists. Inspect it before any further push.');
  const commits = newCommits(worker, git);
  return { ...commits, scope: scopeFor(worker, commits) };
}

function requireRecoveryScope(worker, scope, head) {
  let approved;
  try { approved = JSON.parse(scope); } catch { throw new Error('dispatch: consumed approval scope is malformed. Stop and inspect the destination.'); }
  if (!isFullObjectId(approved?.baseCommit) || !Array.isArray(approved.commits) || approved.commits.at(-1) !== head
    || !approved.commits.every(isFullObjectId) || scopeFor(worker, { ...approved, head }) !== scope) {
    throw new Error('dispatch: consumed approval no longer matches this worker and head. Stop and inspect the destination.');
  }
}

function requireExactHead(worker, head) {
  if (remoteHead(worker) !== head) throw new Error('dispatch: remote readback did not prove the approved head. Stop and inspect the destination.');
}

function recordPushedBranch(worker, { head, isRecoveredPush }, git) {
  git(['update-ref', `refs/remotes/origin/${worker.branch}`, head]);
  git(['branch', `--set-upstream-to=origin/${worker.branch}`, worker.branch]);
  recordPublication(worker, { publication: PUBLICATION.awaitingPr, publishedHead: head, isRecoveredPush });
}

async function recordRecoveredPush(worker, head, dialogId, store) {
  const git = gitFor(worker);
  const scope = await verifyConsumedDiscordPush(dialogId, AFFIRMATIVE_LABEL, store);
  checkLocal(worker, git);
  if (git(['rev-parse', 'HEAD']) !== head) throw new Error('dispatch: head changed before recovery. Stop and inspect the destination.');
  requireRecoveryScope(worker, scope, head);
  requireExactHead(worker, head);
  recordPushedBranch(worker, { head, isRecoveredPush: true }, git);
}

export function workerScope([name]) {
  const worker = repositoryWorker(name);
  const git = gitFor(worker);
  checkLocal(worker, git);
  const request = firstPush(worker, git);
  const pr = isAccorWorker(worker) ? 'PR ready for review' : 'draft PR';
  const options = [{ label: AFFIRMATIVE_LABEL, detail: `Push ${request.commits.length} commits to ${worker.branch}, then open its ${pr}`, recommended: true }, DECLINE_LABEL];
  return { ...request, question: { purpose: 'push', scope: request.scope, ...(worker.servedRequest && { for: worker.servedRequest }), options } };
}

export async function publishWorker([name, dialogId, label], store = humanStore()) {
  if (label !== AFFIRMATIVE_LABEL) throw new Error(`dispatch: publication requires the explicit affirmative label "${AFFIRMATIVE_LABEL}".`);
  const worker = repositoryWorker(name);
  if (!isAccorWorker(worker)) return publish(worker, dialogId, store);
  const release = lockWorkerPublication(worker);
  try {
    return await publish(repositoryWorker(name), dialogId, store);
  } finally {
    release();
  }
}

async function publish(worker, dialogId, store) {
  const git = gitFor(worker);
  checkLocal(worker, git);
  if (store.get(dialogId)?.consumption) {
    await recordRecoveredPush(worker, git(['rev-parse', 'HEAD']), dialogId, store);
    return openRecordedPR(repositoryWorker(worker.name));
  }
  const request = firstPush(worker, git);
  await consumeDiscordPush(dialogId, { scope: request.scope, label: AFFIRMATIVE_LABEL }, store);
  checkLocal(worker, git);
  if (git(['rev-parse', 'HEAD']) !== request.head) throw new Error('dispatch: publication changed after consumption. Ask for a new approval.');
  try {
    pushApproved(worker, request.head);
  } catch (pushError) {
    try { await recordRecoveredPush(worker, request.head, dialogId, store); } catch (readbackError) {
      throw new AggregateError([pushError, readbackError], 'dispatch: first push failed and exact remote readback did not prove recovery. Stop and inspect the destination.');
    }
    return openRecordedPR(repositoryWorker(worker.name));
  }
  recordPushedBranch(worker, request, git);
  return openRecordedPR(repositoryWorker(worker.name));
}

function withPublicationLock(name, operation) {
  const release = lockWorkerPublication(repositoryWorker(name));
  try {
    return operation(repositoryWorker(name));
  } finally {
    release();
  }
}

export function openWorkerPR([name]) {
  const worker = repositoryWorker(name);
  return isAccorWorker(worker) ? withPublicationLock(name, openRecordedPR) : openRecordedPR(worker);
}

function openRecordedPR(worker) {
  if (worker.pullRequest) return isAccorWorker(worker) ? verifiedRemote(worker).pullRequest : worker.pullRequest;
  if (worker.publication !== PUBLICATION.awaitingPr) throw new Error('dispatch: no successful approved first push is recorded.');
  const pullRequest = isAccorWorker(worker) ? openReadyPR(worker, () => requireExactHead(worker, worker.publishedHead)) : openDraftPR(worker);
  recordPublication(worker, { publication: PUBLICATION.published, pullRequest });
  return pullRequest;
}

function openDraftPR(worker) {
  const options = { cwd: worker.worktree };
  if (command('git', ['remote', 'get-url', 'origin'], options) !== worker.originUrl) throw new Error('dispatch: origin changed before draft PR creation.');
  if (!worker.isRecoveredPush) {
    command('git', ['fetch', '--quiet', '--no-tags', worker.originUrl, `refs/heads/${worker.branch}`], options);
    command('git', ['merge-base', '--is-ancestor', worker.publishedHead, 'FETCH_HEAD'], options);
  }
  const candidates = JSON.parse(command('gh', ['pr', 'list', '--repo', worker.repository, '--head', worker.branch, '--state', 'open', '--json', 'url,isCrossRepository,baseRefName,headRefName,isDraft,headRefOid'], options));
  const existing = candidates.find(pr => pr.isCrossRepository === false && pr.baseRefName === worker.base && pr.headRefName === worker.branch);
  if (worker.isRecoveredPush) {
    if (existing && (existing.isDraft !== true || existing.headRefOid !== worker.publishedHead)) {
      throw new Error('dispatch: the recorded branch has an open PR but no matching draft for the approved head. Stop and inspect the PR.');
    }
    requireExactHead(worker, worker.publishedHead);
  }
  return existing?.url || command('gh', ['pr', 'create', '--repo', worker.repository, '--draft', '--base', worker.base, '--head', worker.branch, '--title', worker.title, '--body', ''], options);
}

function verifiedRemote(worker) {
  const head = remoteHead(worker);
  if (!head) throw new Error('dispatch: the recorded PR branch is missing from origin. Inspect publication before pushing.');
  return { head, pullRequest: verifyPublishedPR(worker, head) };
}

function pushFollowUp(worker) {
  if (!accorPublicationPolicy(sandbox)) throw new Error('dispatch: use the current loaded push policy for this worker.');
  if ((worker.publication && worker.publication !== PUBLICATION.published) || !worker.pullRequest) {
    throw new Error('dispatch: no published PR is recorded. Use the first-publication procedure or ask the work center to inspect the branch.');
  }
  const target = { ...worker, originUrl: worker.originUrl ?? repositoryOrigin(worker.repository, worker.worktree) };
  const git = gitFor(target);
  checkCheckout(target, git);
  const remote = verifiedRemote(target);
  const head = git(['rev-parse', 'HEAD']);
  git(['merge-base', '--is-ancestor', remote.head, head]);
  if (worker.publishedHead) git(['merge-base', '--is-ancestor', worker.publishedHead, remote.head]);
  if (head !== remote.head) pushExisting(target, head, remote.head);
  requireExactHead(target, head);
  git(['update-ref', `refs/remotes/origin/${worker.branch}`, head]);
  return remote.pullRequest;
}

export const pushWorker = ([name]) => withPublicationLock(name, pushFollowUp);
