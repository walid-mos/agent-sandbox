import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'dispatch-branches-'));
const session = join(fixture, 'session');
const binaries = join(fixture, 'bin');
const allowedRepository = 'accor-hotels/product-data-apps';
const jiraBranch = 'feat/DA-250-freeze-campaign-establishments';
const pullRequest = 'https://github.invalid/probe/pull/1';
const launch = { title: 'feat(api): DA-250 — freeze campaign establishments', subject: 'feat(api): freeze campaign establishments (DA-250)' };
const BRANCH_REFUSAL = /^dispatch: use .*branch/;
const OWNER_REFUSAL = /^dispatch: use owner\/repo/;
const LAUNCH_REFUSAL = /^dispatch: give --title/;

function prepare() {
  mkdirSync(session);
  mkdirSync(binaries);
  copyFileSync(join(repository, 'session/dispatch.mjs'), join(session, 'dispatch.mjs'));
  writeFileSync(join(session, 'sandbox.mjs'), 'export const sandbox = { owners: { "accor-hotels": "UNUSED_PROBE_TOKEN" }, bot: "Probe" }; export const owners = Object.keys(sandbox.owners); export const botId = sandbox.bot.toLowerCase();\n');
  writeFileSync(join(fixture, 'copy-imports.mjs'), `
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const source = pathToFileURL(${JSON.stringify(repository)});
const target = pathToFileURL(${JSON.stringify(fixture + '/')});
const record = (kind, url) => appendFileSync(new URL(kind + '.jsonl', target), JSON.stringify(fileURLToPath(url)) + '\\n');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('.') || !context.parentURL?.startsWith(target.href)) return nextResolve(specifier, context);
    const destination = new URL(specifier, context.parentURL);
    if (destination.href.startsWith(target.href) && !existsSync(destination)) {
      mkdirSync(dirname(fileURLToPath(destination)), { recursive: true });
      copyFileSync(new URL(destination.href.slice(target.href.length), source), destination);
      record('copied', destination);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url.startsWith(target.href)) record('loaded', url);
    return loaded;
  },
});
`);
  const executable = join(binaries, 'fake-command');
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
const binary = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.HOME + '/commands.jsonl', JSON.stringify({ directory: process.cwd(), argv: [binary, ...args] }) + '\\n');
if (binary === 'git' && args[0] === 'clone') mkdirSync(join(args.at(-1), '.git'), { recursive: true });
if (binary === 'git' && args[0] === 'worktree') mkdirSync(args.at(-2), { recursive: true });
if (binary === 'bash') console.log(${JSON.stringify(pullRequest)});
`, { mode: 0o700 });
  for (const binary of ['git', 'gh', 'bash', 'hc']) symlinkSync(executable, join(binaries, binary));
}

function invoke(branch, target, { title, subject }, mode = 'start') {
  const home = mkdtempSync(join(fixture, 'home-'));
  const configuration = join(home, '.pi/agent/extensions/subagent');
  mkdirSync(configuration, { recursive: true });
  writeFileSync(join(configuration, 'config.json'), JSON.stringify({ worktreeBaseDir: '.worktree' }));
  const brief = join(home, 'request.md');
  writeFileSync(brief, 'Synthetic dispatch probe.');
  const options = [...(title === undefined ? [] : ['--title', title]), ...(subject === undefined ? [] : ['--subject', subject])];
  const args = mode === 'task'
    ? ['task', '--title', title, '--scope', 'Read the supplied brief and write one report.', 'report', home, brief, join(home, 'result.md')]
    : ['start', ...(mode === 'local' ? ['--local'] : []), ...options, '--', target, branch, brief, 'develop'];
  const result = spawnSync(process.execPath, ['--import', join(fixture, 'copy-imports.mjs'), join(session, 'dispatch.mjs'), ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000, env: { HOME: home, PATH: binaries },
  });
  assert.ifError(result.error);
  const log = join(home, 'commands.jsonl');
  const entries = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { ...result, home, calls: entries.map(entry => entry.argv), directories: entries.map(entry => entry.directory) };
}

function accepted(branch, values = launch) {
  const result = invoke(branch, allowedRepository, values);
  assert.equal(result.status, 0, `${branch}: ${result.stderr}`);
  assert.equal(result.stderr, '');
  const worker = JSON.parse(result.stdout);
  assert.equal(worker.branch, branch);
  assert.equal(worker.repository, allowedRepository);
  assert.equal(worker.pullRequest, pullRequest);
  const checkout = join(result.home, 'Development', allowedRepository);
  const worktree = join(checkout, '.worktree/product-data-apps', branch.replaceAll('/', '-'));
  assert.deepEqual(result.calls, [
    ['git', 'clone', '--quiet', `https://github.com/${allowedRepository}.git`, checkout],
    ['git', 'fetch', '--quiet', 'origin', 'develop'],
    ['git', 'worktree', 'add', '-b', branch, worktree, 'origin/develop'],
    ['git', 'commit', '--quiet', '--allow-empty', '-m', values.subject],
    ['bash', join(result.home, '.pi/agent/skills/worktree/scripts/draft-pr'), worktree, values.title, 'develop'],
  ]);
  assert.deepEqual(result.directories, [fixture, checkout, checkout, worktree, worktree]);
  const workers = join(result.home, '.config/agent-sandbox/workers');
  assert.equal(JSON.parse(readFileSync(join(workers, worker.name + '.json'), 'utf8')).branch, branch);
  assert.equal(readdirSync(join(workers, 'queue')).length, 1);
}

function refused(reason, branch, target = allowedRepository, values = launch) {
  const result = invoke(branch, target, values);
  assert.equal(result.status, 1, `${target} ${JSON.stringify(branch)} ${JSON.stringify(values)}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, reason);
  assert.deepEqual(result.calls, [], 'no Git, GitHub, PR or terminal commands before refusal');
  assert.equal(existsSync(join(result.home, 'Development')), false, 'no checkout or worktree');
  assert.equal(existsSync(join(result.home, '.config/agent-sandbox/workers')), false, 'no worker record, brief or queue');
}

try {
  prepare();
  const local = invoke(jiraBranch, allowedRepository, launch, 'local');
  assert.equal(local.status, 0, local.stderr);
  const localWorker = JSON.parse(local.stdout);
  assert.equal(localWorker.publication, 'local');
  assert.equal(localWorker.pullRequest, undefined);
  assert.equal(local.calls.some(args => ['bash', 'hc'].includes(args[0]) || args.includes('push')), false);
  const task = invoke('', '', launch, 'task');
  assert.equal(task.status, 0, task.stderr);
  const taskWorker = JSON.parse(task.stdout);
  assert.equal(taskWorker.kind, 'task');
  assert.equal(taskWorker.repository, undefined);
  assert.deepEqual(task.calls, [], 'non-repository launch has no Git, GitHub, PR or immediate terminal side effect');
  assert.equal(readdirSync(join(task.home, '.config/agent-sandbox/workers/queue')).length, 1);
  accepted(jiraBranch);
  accepted(jiraBranch, { title: '[DA-250] Freeze campaign establishments', subject: 'Start DA-250' });
  for (const prefix of ['feat', 'fix', 'chore', 'docs', 'refactor', 'test']) accepted(`${prefix}/worker-task-250`);
  for (const branch of ['', 'feat/', 'Feat/DA-250-task', 'feature/DA-250-task', 'main', '-feat/task', 'feat/task/extra',
    'feat//task', 'feat/../task', 'feat/task..name', 'feat/task.lock', 'feat/.hidden', 'feat/task.', 'feat/task@{1}',
    'feat/task name', 'feat/task\tname', 'feat/task\n', 'feat/task\r', 'feat/task\\name', 'feat/task:name',
    'feat/task?name', 'feat/task*name', 'feat/task[name', 'feat/$(touch marker)', 'feat/task;touch-marker']) refused(BRANCH_REFUSAL, branch);
  refused(OWNER_REFUSAL, jiraBranch, 'outside-owner/product-data-apps');
  refused(OWNER_REFUSAL, jiraBranch, 'https://github.com/accor-hotels/product-data-apps');
  refused(LAUNCH_REFUSAL, jiraBranch, allowedRepository, { subject: launch.subject });
  refused(LAUNCH_REFUSAL, jiraBranch, allowedRepository, { title: launch.title });
  for (const value of ['', ' leading space', 'trailing space ', 'two\nlines', 'tab\there', 'carriage\rreturn', 'line\u2028separator', 'bidi \u202Eoverride', 'zero\u200Bwidth']) {
    refused(LAUNCH_REFUSAL, jiraBranch, allowedRepository, { ...launch, title: value });
    refused(LAUNCH_REFUSAL, jiraBranch, allowedRepository, { ...launch, subject: value });
  }
  const recorded = kind => readFileSync(join(fixture, kind + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const copied = new Set([join(session, 'dispatch.mjs'), join(session, 'sandbox.mjs'), ...recorded('copied')]);
  const loaded = new Set(recorded('loaded'));
  assert.deepEqual([...copied].sort(), [...loaded].sort(), 'copy exactly the active dispatch module graph');
  console.log('ok   dispatch preserves Jira branch and develop base, commits the given bootstrap subject in the worktree, opens the draft PR with the given title in any repository format, refuses malformed refs, titles, subjects and unsupported repositories before side effects');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
