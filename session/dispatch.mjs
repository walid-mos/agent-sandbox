import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { main, runOperation } from './main.mjs';
import { MAX_MODEL } from './models.mjs';
import { command } from './run.mjs';
import { owners, sandbox } from './sandbox.mjs';
import { clearStop, launch, liveTerminals, RESUME, terminalName, terminalOf, WORKER_PREFIX, workers, writeBrief } from './workers.mjs';

const WORKSPACES = join(homedir(), 'Development');
const DRAFT_PR = join(homedir(), '.pi/agent/skills/worktree/scripts/draft-pr');
const CLEAN_PASS_GUIDE = join(dirname(fileURLToPath(import.meta.url)), 'clean-pass.md');
const START_OPTIONS = { max: { type: 'boolean' } };

function validate(repository, branch) {
  const owner = /^([^/]+)\/[a-zA-Z0-9_.-]+$/.exec(repository ?? '')?.[1];
  if (!owners.includes(owner)) throw new Error(`dispatch: use owner/repo under ${owners.join(' or ')}.`);
  if (!/^(feat|fix|chore|docs|refactor|test)\/[a-z0-9-]+$/.test(branch ?? '')) {
    throw new Error('dispatch: use a lowercase branch such as feat/worker-task');
  }
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

function start(arguments_) {
  const { values, positionals } = parseArgs({ args: arguments_, options: START_OPTIONS, allowPositionals: true });
  const [repository, branch, briefFile, requestedBase] = positionals;
  validate(repository, branch);
  const name = terminalName(`${WORKER_PREFIX}${repository.split('/')[1]}-${branch}`, `${repository}/${branch}`);
  if (workers().some(worker => worker.name === name)) {
    throw new Error(`dispatch: worker ${name} already exists. Send to that worker or choose a new branch.`);
  }
  const request = readFileSync(briefFile, 'utf8');
  const base = requestedBase ?? command('gh', ['api', `repos/${repository}`, '--jq', '.default_branch']);
  const worktree = workspace(repository, branch, base);
  const title = `${branch.split('/')[0]}: ${branch.split('/')[1].replaceAll('-', ' ')}`;
  const pullRequest = command('bash', [DRAFT_PR, worktree, title, base], { cwd: worktree });
  const brief = writeBrief(name, `${request}\n\nWork only in ${worktree}, branch ${branch}. Draft PR: ${pullRequest}. Use the installed Pi harness and its skills. This checkout already is this task's worktree; do not hand it off again. The only agents you start are the passes of the clean pass. Commit atomic Conventional Commits. Push this branch only as the rules loaded in this session allow. When a push waits for the person's yes, end your turn naming the branch, the remote and the waiting commits; ${sandbox.bot} brings the yes back as a message, and it covers that one push. Before your final response, read ${CLEAN_PASS_GUIDE}: run the clean pass when the task owes one, then mark the pull request ready or keep it in draft as it says. Report the PR, checks, commit, unpushed commits and uncommitted paths in your final response. The Pots watcher will relay your completion to ${sandbox.bot}.\n`);
  const worker = launch({ name, repository, branch, worktree, brief, pullRequest, request, createdAt: Date.now(), ...(values.max && { model: MAX_MODEL }) }, [`@${brief}`]);
  process.stdout.write(`${JSON.stringify(worker)}\n`);
}

// A worker whose terminal is gone, or that was stopped, comes back with its conversation to read the message.
function send([name, messageFile]) {
  const worker = workers().find(candidate => candidate.name === name);
  if (!worker) throw new Error(`dispatch: no worker named ${name}. Use one of: ${workers().map(known => known.name).join(', ') || 'none started yet'}.`);
  const message = readFileSync(messageFile, 'utf8').trim();
  if (!message) throw new Error(`dispatch: ${messageFile} is empty. Write the message in it, then send again.`);
  clearStop(worker);
  const terminal = terminalOf(worker, liveTerminals());
  if (terminal) command('hc', ['send', '--', terminal.address, message]);
  else launch(worker, [RESUME, '--', message]);
}

const OPERATIONS = { start, send };
const USAGE = 'usage: dispatch start [--max] owner/repo type/branch brief-file [base] | dispatch send worker message-file';

main(import.meta, () => runOperation(OPERATIONS, USAGE));
