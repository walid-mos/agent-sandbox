import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { accorPublicationPolicy } from './accor-publication-policy.mjs';
import { repositoryOrigin } from './repository-origin.mjs';
import { find } from './door-requests.mjs';
import { unselectedTask, associatedWorker } from './tasks.mjs';
import { taskLock } from './task-store.mjs';
import { main, runOperation } from './main.mjs';
import { MAX_MODEL } from './models.mjs';
import { enqueue } from './queue.mjs';
import { command } from './run.mjs';
import { botId, owners, sandbox } from './sandbox.mjs';
import { repositoryBrief, taskBrief } from './worker-brief.mjs';
import { openWorkerPR, publishWorker, pushWorker, workerScope } from './worker-publication.mjs';
import { acknowledgeResult } from './worker-results.mjs';
import { clearStop, PUBLICATION, save, terminalName, WORKER_PREFIX, workers, writeBrief } from './workers.mjs';

const WORKSPACES = join(homedir(), 'Development');
const DRAFT_PR = join(homedir(), '.pi/agent/skills/worktree/scripts/draft-pr');
const START_OPTIONS = { task: { type: 'string' }, max: { type: 'boolean' }, for: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, local: { type: 'boolean' } };
const TASK_OPTIONS = { max: START_OPTIONS.max, for: START_OPTIONS.for, title: START_OPTIONS.title, scope: { type: 'string' } };
// Invisible and line-breaking characters are refused so the commit and title are exactly what the person read and approved.
const ONE_VISIBLE_LINE = /^(?! )[\p{L}\p{M}\p{N}\p{P}\p{S} ]+(?<! )$/u;

function validate(repository, branch) {
  const owner = /^([^/]+)\/[a-zA-Z0-9_.-]+$/.exec(repository ?? '')?.[1];
  if (!owners.includes(owner)) throw new Error(`dispatch: use owner/repo under ${owners.join(' or ')}.`);
  if (!/^(feat|fix|chore|docs|refactor|test)\/[a-zA-Z0-9-]+$/.test(branch ?? '')) {
    throw new Error('dispatch: use a branch such as feat/DA-250-worker-task, with a supported lowercase prefix and only letters, digits or hyphens after the slash');
  }
}

function validateLaunchText({ title, subject }, publicationPolicy) {
  if (ONE_VISIBLE_LINE.test(title ?? '') && (publicationPolicy && subject === undefined || ONE_VISIBLE_LINE.test(subject ?? ''))) return;
  const subjectHelp = publicationPolicy ? ' When supplied, --subject must also be one visible line.' : ' Give --subject for the empty bootstrap commit in the repository\'s own format.';
  throw new Error(`dispatch: give --title in the repository's own format on one line of visible characters with no leading or trailing space.${subjectHelp}`);
}

function workspace(repository, branch, base, publication) {
  const checkout = join(WORKSPACES, repository);
  mkdirSync(join(checkout, '..'), { recursive: true });
  if (!existsSync(join(checkout, '.git'))) command('git', ['clone', '--quiet', `https://github.com/${repository}.git`, checkout]);
  const originUrl = publication === PUBLICATION.local ? repositoryOrigin(repository, checkout) : undefined;
  const config = JSON.parse(readFileSync(join(homedir(), '.pi/agent/extensions/subagent/config.json'), 'utf8'));
  const worktree = join(checkout, config.worktreeBaseDir, repository.split('/')[1], branch.replaceAll('/', '-'));
  if (existsSync(worktree)) throw new Error('dispatch: worktree exists. Send to its worker or choose a new branch.');
  command('git', ['fetch', '--quiet', 'origin', base], { cwd: checkout });
  command('git', ['worktree', 'add', '-b', branch, worktree, `origin/${base}`], { cwd: checkout });
  return { worktree, originUrl };
}

function checkServedRequest(requested) {
  if (!requested) return;
  const served = find(requested);
  if (served?.direction !== 'received' || served.state !== 'open') throw new Error('dispatch: --for must name an open incoming door request.');
}

function ensureNewWorker(name) {
  if (!workers().some(worker => worker.name === name)) return;
  throw new Error(`dispatch: worker ${name} already exists. Send to that worker or choose a new branch.`);
}

function start(arguments_) {
  const { values, positionals } = parseArgs({ args: arguments_, options: START_OPTIONS, allowPositionals: true });
  if (values.task) return taskLock(() => startWorker(values, positionals));
  return startWorker(values, positionals);
}

function startWorker(values, [repository, branch, briefFile, requestedBase]) {
  if (values.task) {
    unselectedTask(values.task);
    const known = associatedWorker(values.task);
    if (known) return repeatStart(known, repository, branch, briefFile);
  }
  validate(repository, branch);
  const publicationPolicy = accorPublicationPolicy(sandbox);
  validateLaunchText(values, publicationPolicy);
  checkServedRequest(values.for);
  const name = terminalName(`${WORKER_PREFIX}${repository.split('/')[1]}-${branch}`, `${repository}/${branch}`);
  ensureNewWorker(name);
  const request = readFileSync(briefFile, 'utf8');
  const base = requestedBase ?? command('gh', ['api', `repos/${repository}`, '--jq', '.default_branch']);
  const publication = values.local || publicationPolicy ? PUBLICATION.local : undefined;
  const { worktree, originUrl } = workspace(repository, branch, base, publication);
  if (!publicationPolicy) command('git', ['commit', '--quiet', '--allow-empty', '-m', values.subject], { cwd: worktree });
  const pullRequest = publication ? undefined : command('bash', [DRAFT_PR, worktree, values.title, base], { cwd: worktree });
  const worker = { name, kind: 'repository', owner: botId, repository, branch, worktree, pullRequest, request, base,
    title: values.title, subject: values.subject, servedRequest: values.for, createdAt: Date.now(), ...(values.task && { taskId: values.task }),
    ...(values.max && { model: MAX_MODEL }),
    ...(publication && { publication, originUrl }), ...(publicationPolicy && { publicationPolicy }) };
  queueWorker(worker, repositoryBrief(worker));
}

function repeatStart(worker, repository, branch, briefFile) {
  if (worker.repository !== repository || worker.branch !== branch || worker.request !== readFileSync(briefFile, 'utf8')) {
    throw new Error('dispatch: task already has a different worker or brief. Follow up with its existing worker.');
  }
  process.stdout.write(`${JSON.stringify({ ...worker, admission: 'memory' })}\n`);
}

function queueWorker(worker, text) {
  const brief = writeBrief(worker.name, text);
  save({ ...worker, brief });
  enqueue({ worker: worker.name });
  process.stdout.write(`${JSON.stringify({ ...worker, brief, admission: 'memory' })}\n`);
}

function taskDirectory(directory, resultFile) {
  if (!isAbsolute(directory) || !isAbsolute(resultFile)) throw new Error('dispatch: task workdir and result-file must be absolute paths.');
  const worktree = realpathSync(directory);
  const resultParent = realpathSync(dirname(resultFile));
  if (!(resultParent === worktree || resultParent.startsWith(worktree + sep)) || existsSync(resultFile)) {
    throw new Error('dispatch: use a new result-file within the task workdir.');
  }
  return worktree;
}

function task(arguments_) {
  const { values, positionals } = parseArgs({ args: arguments_, options: TASK_OPTIONS, allowPositionals: true });
  const [id, directory, briefFile, resultFile] = positionals;
  if (positionals.length !== 4 || !/^[a-zA-Z0-9-]+$/.test(id ?? '') || !ONE_VISIBLE_LINE.test(values.title ?? '') || !ONE_VISIBLE_LINE.test(values.scope ?? '')) {
    throw new Error('dispatch: task needs --title, --scope, a task name, absolute workdir, brief-file and absolute result-file.');
  }
  const worktree = taskDirectory(directory, resultFile);
  checkServedRequest(values.for);
  const name = terminalName(`${WORKER_PREFIX}task-${id}`);
  ensureNewWorker(name);
  const request = readFileSync(briefFile, 'utf8').trim();
  if (!request) throw new Error('dispatch: the task brief must describe its bounded result.');
  const worker = { name, kind: 'task', title: values.title, scope: values.scope, resultFile, worktree, request,
    owner: botId, servedRequest: values.for, createdAt: Date.now(), ...(values.max && { model: MAX_MODEL }) };
  queueWorker(worker, taskBrief(worker));
}

function send([name, messageFile]) {
  const worker = workers().find(candidate => candidate.name === name);
  if (!worker) throw new Error(`dispatch: no worker named ${name}. Use one of: ${workers().map(known => known.name).join(', ') || 'none started yet'}.`);
  const message = readFileSync(messageFile, 'utf8').trim();
  if (!message) throw new Error(`dispatch: ${messageFile} is empty. Write the message in it, then send again.`);
  clearStop(worker);
  enqueue({ worker: name, message });
}

const OPERATIONS = { start, task, send, scope: args => process.stdout.write(`${JSON.stringify(workerScope(args))}\n`),
  publish: async args => process.stdout.write(`${await publishWorker(args)}\n`),
  'open-pr': args => process.stdout.write(`${openWorkerPR(args)}\n`), push: args => process.stdout.write(`${pushWorker(args)}\n`), finish: acknowledgeResult };
const USAGE = 'usage: dispatch start [--local] [--max] [--for REQUEST_ID] [--task TASK_ID] --title PR_TITLE [--subject COMMIT_SUBJECT] owner/repo type/branch brief-file [base] | task [--max] [--for REQUEST_ID] --title TITLE --scope SCOPE task-name workdir brief-file result-file | scope worker | publish worker dialog-id affirmative-label | open-pr worker | push worker | send worker message-file | finish worker result-id';

main(import.meta, () => runOperation(OPERATIONS, USAGE));
