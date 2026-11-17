import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { find } from './door-requests.mjs';
import { main, runOperation } from './main.mjs';
import { idleStackMinutes, maxWorkers } from './limits.mjs';
import { MAX_MODEL } from './models.mjs';
import { enqueue, queued } from './queue.mjs';
import { command } from './run.mjs';
import { botId, owners, sandbox } from './sandbox.mjs';
import { acknowledgeResult } from './worker-results.mjs';
import { clearStop, save, terminalName, WORKER_PREFIX, workers, writeBrief } from './workers.mjs';

const WORKSPACES = join(homedir(), 'Development');
const DRAFT_PR = join(homedir(), '.pi/agent/skills/worktree/scripts/draft-pr');
const CLEAN_PASS_GUIDE = join(dirname(fileURLToPath(import.meta.url)), 'clean-pass.md');
const START_OPTIONS = { max: { type: 'boolean' }, for: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' } };
// Invisible and line-breaking characters are refused so the commit and title are exactly what the person read and approved.
const ONE_VISIBLE_LINE = /^(?! )[\p{L}\p{M}\p{N}\p{P}\p{S} ]+(?<! )$/u;

function validate(repository, branch) {
  const owner = /^([^/]+)\/[a-zA-Z0-9_.-]+$/.exec(repository ?? '')?.[1];
  if (!owners.includes(owner)) throw new Error(`dispatch: use owner/repo under ${owners.join(' or ')}.`);
  if (!/^(feat|fix|chore|docs|refactor|test)\/[a-zA-Z0-9-]+$/.test(branch ?? '')) {
    throw new Error('dispatch: use a branch such as feat/DA-250-worker-task, with a supported lowercase prefix and only letters, digits or hyphens after the slash');
  }
}

function validateLaunchText(title, subject) {
  if ([title, subject].every(text => ONE_VISIBLE_LINE.test(text ?? ''))) return;
  throw new Error('dispatch: give --title, the pull request title, and --subject, the empty bootstrap commit\'s subject, each in the repository\'s own format for that artefact, on one line of visible characters with no leading or trailing space.');
}

function workspace(repository, branch, base) {
  const checkout = join(WORKSPACES, repository);
  mkdirSync(join(checkout, '..'), { recursive: true });
  if (!existsSync(join(checkout, '.git'))) command('git', ['clone', '--quiet', `https://github.com/${repository}.git`, checkout]);
  const config = JSON.parse(readFileSync(join(homedir(), '.pi/agent/extensions/subagent/config.json'), 'utf8'));
  const worktree = join(checkout, config.worktreeBaseDir, repository.split('/')[1], branch.replaceAll('/', '-'));
  if (existsSync(worktree)) throw new Error('dispatch: worktree exists. Send to its worker or choose a new branch.');
  command('git', ['fetch', '--quiet', 'origin', base], { cwd: checkout });
  command('git', ['worktree', 'add', '-b', branch, worktree, `origin/${base}`], { cwd: checkout });
  return worktree;
}

function servedRequest(requested) {
  const served = requested && find(requested);
  if (requested && (served?.direction !== 'received' || served.state !== 'open')) throw new Error('dispatch: --for must name an open incoming door request.');
  return served;
}

function ensureNewWorker(name) {
  if (!workers().some(worker => worker.name === name)) return;
  throw new Error(`dispatch: worker ${name} already exists. Send to that worker or choose a new branch.`);
}

function start(arguments_) {
  const { values, positionals } = parseArgs({ args: arguments_, options: START_OPTIONS, allowPositionals: true });
  const [repository, branch, briefFile, requestedBase] = positionals;
  validate(repository, branch);
  validateLaunchText(values.title, values.subject);
  const served = servedRequest(values.for);
  const name = terminalName(`${WORKER_PREFIX}${repository.split('/')[1]}-${branch}`, `${repository}/${branch}`);
  ensureNewWorker(name);
  const request = readFileSync(briefFile, 'utf8');
  const base = requestedBase ?? command('gh', ['api', `repos/${repository}`, '--jq', '.default_branch']);
  const worktree = workspace(repository, branch, base);
  // draft-pr adds its own empty commit, with the title as subject, only to a branch without one, so this keeps the commit format apart.
  command('git', ['commit', '--quiet', '--allow-empty', '-m', values.subject], { cwd: worktree });
  const pullRequest = command('bash', [DRAFT_PR, worktree, values.title, base], { cwd: worktree });
  const brief = writeBrief(name, `${request}\n\nWork only in ${worktree}, branch ${branch}. Draft PR: ${pullRequest}. Use the installed Pi harness and its skills. This checkout already is this task's worktree; do not hand it off again. The only agents you start are the passes of the clean pass. This fresh checkout has no dependencies, so the repository's commit hooks do not run yet: before your first commit, install its dependencies as it documents and the rules loaded in this session allow, then check the empty commit that opened the pull request against its commit rules and report a mismatch instead of rewriting that pushed commit. Commit atomically, in the repository's own commit format. When no terminal runs in this worktree for ${idleStackMinutes} minutes, the Pots watcher stops its Compose projects with docker compose stop and keeps their volumes: start a stopped one again with docker compose start. Push this branch only as the rules loaded in this session allow. When a push waits for the person's yes, end your turn naming the branch, the remote and the waiting commits; ${sandbox.bot} brings the yes back as a message, and it covers that one push. Before your final response, read ${CLEAN_PASS_GUIDE}: run the clean pass when the task owes one, then mark the pull request ready or keep it in draft as it says. Report the PR, checks, commit, unpushed commits and uncommitted paths in your final response. The Pots watcher will relay your completion to ${sandbox.bot}.\n`);
  const worker = { name, owner: botId, repository, branch, worktree, brief, pullRequest, request, servedRequest: values.for, createdAt: Date.now(), ...(values.max && { model: MAX_MODEL }) };
  // The record comes first: the watcher drops a request that names no worker.
  save(worker);
  const ahead = queued().length;
  enqueue({ worker: name });
  process.stdout.write(`${JSON.stringify({ ...worker, ahead, maxWorkers })}\n`);
}

// A worker whose terminal is gone, or that was stopped, comes back with its conversation to read the message, once a slot is free.
function send([name, messageFile]) {
  const worker = workers().find(candidate => candidate.name === name);
  if (!worker) throw new Error(`dispatch: no worker named ${name}. Use one of: ${workers().map(known => known.name).join(', ') || 'none started yet'}.`);
  const message = readFileSync(messageFile, 'utf8').trim();
  if (!message) throw new Error(`dispatch: ${messageFile} is empty. Write the message in it, then send again.`);
  clearStop(worker);
  enqueue({ worker: name, message });
}

const OPERATIONS = { start, send, finish: acknowledgeResult };
const USAGE = 'usage: dispatch start [--max] [--for REQUEST_ID] --title PR_TITLE --subject COMMIT_SUBJECT owner/repo type/branch brief-file [base] | dispatch send worker message-file | dispatch finish worker result-id';

main(import.meta, () => runOperation(OPERATIONS, USAGE));
