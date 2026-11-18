import { consumeDiscordPush } from './human-consume.mjs';
import { humanStore } from './human-store.mjs';
import { pushApproved } from './push-approved.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { ownedWorker, PUBLICATION, recordPublication } from './workers.mjs';

const AFFIRMATIVE_LABEL = 'Push once';
const DECLINE_LABEL = 'Keep local';

function repositoryWorker(name) {
  const worker = ownedWorker(name, botId);
  if (!worker?.repository || worker.kind === 'task') throw new Error('dispatch: publication requires an owned repository worker.');
  return worker;
}

function checkCheckout(worker, git) {
  if (worker.publication !== PUBLICATION.local) throw new Error('dispatch: this worker is not waiting for its first approved push. Use open-pr after a successful push.');
  if (git(['branch', '--show-current']) !== worker.branch) throw new Error('dispatch: task branch changed. Restore it before publication.');
  if (!worker.originUrl || git(['remote', 'get-url', 'origin']) !== worker.originUrl) throw new Error('dispatch: origin changed. Restore it and ask for a new approval.');
  if (git(['remote', 'get-url', '--push', '--all', 'origin']) !== worker.originUrl) throw new Error('dispatch: push destination differs from the approved origin. Restore it before asking for approval.');
  if (git(['status', '--porcelain'])) throw new Error('dispatch: commit or remove local changes before requesting publication.');
}

function newCommits(worker, git) {
  git(['fetch', '--quiet', 'origin', worker.base]);
  const baseCommit = git(['rev-parse', `refs/remotes/origin/${worker.base}`]);
  const head = git(['rev-parse', 'HEAD']);
  if (git(['merge-base', baseCommit, head]) !== baseCommit) throw new Error('dispatch: the branch no longer contains the fresh base. Inspect it before publication.');
  const commits = git(['rev-list', '--reverse', `${baseCommit}..${head}`]).split('\n').filter(Boolean);
  if (!commits.length) throw new Error('dispatch: first publication needs at least one commit above the fresh base.');
  if (git(['ls-remote', '--heads', 'origin', `refs/heads/${worker.branch}`])) throw new Error('dispatch: the remote task branch already exists. Inspect it before any further push.');
  return { baseCommit, head, commits };
}

// The scope names every commit by its full ID, so a later commit, base, remote or title needs a new question.
function firstPush(worker) {
  const git = args => command('git', args, { cwd: worker.worktree });
  checkCheckout(worker, git);
  const { baseCommit, head, commits } = newCommits(worker, git);
  const scope = JSON.stringify({ operation: 'first-worker-push', repository: worker.repository, branch: worker.branch,
    remote: 'origin', url: worker.originUrl, base: worker.base, baseCommit, commits, head, draftTitle: worker.title });
  return { scope, commits, head };
}

export function workerScope([name]) {
  const worker = repositoryWorker(name);
  const request = firstPush(worker);
  const options = [{ label: AFFIRMATIVE_LABEL, detail: `Push ${request.commits.length} commits to ${worker.branch}, then open its draft PR`, recommended: true }, DECLINE_LABEL];
  return { ...request, question: { purpose: 'push', scope: request.scope, ...(worker.servedRequest && { for: worker.servedRequest }), options } };
}

export async function publishWorker([name, dialogId, label], store = humanStore()) {
  if (label !== AFFIRMATIVE_LABEL) throw new Error(`dispatch: publication requires the explicit affirmative label "${AFFIRMATIVE_LABEL}".`);
  const worker = repositoryWorker(name);
  const request = firstPush(worker);
  await consumeDiscordPush(dialogId, { scope: request.scope, label }, store);
  const options = { cwd: worker.worktree };
  const git = args => command('git', args, options);
  checkCheckout(worker, git);
  if (git(['rev-parse', 'HEAD']) !== request.head) throw new Error('dispatch: publication changed after consumption. Ask for a new approval.');
  pushApproved(worker, request.head);
  recordPublication(worker, { publication: PUBLICATION.awaitingPr, publishedHead: request.head });
  git(['update-ref', `refs/remotes/origin/${worker.branch}`, request.head]);
  git(['branch', `--set-upstream-to=origin/${worker.branch}`, worker.branch]);
  return openWorkerPR([name]);
}

export function openWorkerPR([name]) {
  const worker = repositoryWorker(name);
  if (worker.pullRequest) return worker.pullRequest;
  if (worker.publication !== PUBLICATION.awaitingPr) throw new Error('dispatch: no successful approved first push is recorded.');
  const options = { cwd: worker.worktree };
  if (command('git', ['remote', 'get-url', 'origin'], options) !== worker.originUrl) throw new Error('dispatch: origin changed before draft PR creation.');
  command('git', ['fetch', '--quiet', '--no-tags', worker.originUrl, `refs/heads/${worker.branch}`], options);
  command('git', ['merge-base', '--is-ancestor', worker.publishedHead, 'FETCH_HEAD'], options);
  const candidates = JSON.parse(command('gh', ['pr', 'list', '--repo', worker.repository, '--head', worker.branch, '--state', 'open', '--json', 'url,isCrossRepository,baseRefName,headRefName'], options));
  const existing = candidates.find(pr => pr.isCrossRepository === false && pr.baseRefName === worker.base && pr.headRefName === worker.branch);
  const pullRequest = existing?.url || command('gh', ['pr', 'create', '--repo', worker.repository, '--draft', '--base', worker.base, '--head', worker.branch, '--title', worker.title, '--body', ''], options);
  recordPublication(worker, { publication: PUBLICATION.published, pullRequest });
  return pullRequest;
}
