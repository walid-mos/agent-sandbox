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

function prepare() {
  mkdirSync(session);
  mkdirSync(binaries);
  for (const module of ['dispatch.mjs', 'main.mjs', 'limits.mjs', 'models.mjs', 'queue.mjs', 'run.mjs', 'workers.mjs']) {
    copyFileSync(join(repository, 'session', module), join(session, module));
  }
  writeFileSync(join(session, 'sandbox.mjs'), 'export const sandbox = { owners: { "accor-hotels": "UNUSED_PROBE_TOKEN" }, bot: "Probe" }; export const owners = Object.keys(sandbox.owners);\n');
  const executable = join(binaries, 'fake-command');
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
const binary = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.HOME + '/commands.jsonl', JSON.stringify([binary, ...args]) + '\\n');
if (binary === 'git' && args[0] === 'clone') mkdirSync(join(args.at(-1), '.git'), { recursive: true });
if (binary === 'git' && args[0] === 'worktree') mkdirSync(args.at(-2), { recursive: true });
if (binary === 'bash') console.log(${JSON.stringify(pullRequest)});
`, { mode: 0o700 });
  for (const binary of ['git', 'gh', 'bash', 'hc']) symlinkSync(executable, join(binaries, binary));
}

function invoke(branch, target = allowedRepository) {
  const home = mkdtempSync(join(fixture, 'home-'));
  const configuration = join(home, '.pi/agent/extensions/subagent');
  mkdirSync(configuration, { recursive: true });
  writeFileSync(join(configuration, 'config.json'), JSON.stringify({ worktreeBaseDir: '.worktree' }));
  const brief = join(home, 'request.md');
  writeFileSync(brief, 'Synthetic dispatch probe.');
  const result = spawnSync(process.execPath, [join(session, 'dispatch.mjs'), 'start', '--', target, branch, brief, 'develop'], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000, env: { HOME: home, PATH: binaries },
  });
  assert.ifError(result.error);
  const log = join(home, 'commands.jsonl');
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { ...result, home, calls };
}

function accepted(branch) {
  const result = invoke(branch);
  assert.equal(result.status, 0, `${branch}: ${result.stderr}`);
  assert.equal(result.stderr, '');
  const worker = JSON.parse(result.stdout);
  assert.equal(worker.branch, branch);
  assert.equal(worker.repository, allowedRepository);
  assert.equal(worker.pullRequest, pullRequest);
  const checkout = join(result.home, 'Development', allowedRepository);
  const worktree = join(checkout, '.worktree/product-data-apps', branch.replaceAll('/', '-'));
  assert.deepEqual(result.calls.map(call => call[0]), ['git', 'git', 'git', 'bash']);
  assert.deepEqual(result.calls.slice(0, 3), [
    ['git', 'clone', '--quiet', `https://github.com/${allowedRepository}.git`, checkout],
    ['git', 'fetch', '--quiet', 'origin', 'develop'],
    ['git', 'worktree', 'add', '-b', branch, worktree, 'origin/develop'],
  ]);
  assert.deepEqual(result.calls[3].slice(0, 3), ['bash', join(result.home, '.pi/agent/skills/worktree/scripts/draft-pr'), worktree]);
  assert.equal(result.calls[3].at(-1), 'develop');
  const workers = join(result.home, '.config/agent-sandbox/workers');
  assert.equal(JSON.parse(readFileSync(join(workers, worker.name + '.json'), 'utf8')).branch, branch);
  assert.equal(readdirSync(join(workers, 'queue')).length, 1);
}

function refused(branch, target = allowedRepository) {
  const result = invoke(branch, target);
  assert.equal(result.status, 1, `${target} ${JSON.stringify(branch)}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, target === allowedRepository ? /^dispatch: use .*branch/ : /^dispatch: use owner\/repo/);
  assert.deepEqual(result.calls, [], 'no Git, GitHub, PR or terminal commands before refusal');
  assert.equal(existsSync(join(result.home, 'Development')), false, 'no checkout or worktree');
  assert.equal(existsSync(join(result.home, '.config/agent-sandbox/workers')), false, 'no worker record, brief or queue');
}

try {
  prepare();
  accepted(jiraBranch);
  for (const prefix of ['feat', 'fix', 'chore', 'docs', 'refactor', 'test']) accepted(`${prefix}/worker-task-250`);
  for (const branch of ['', 'feat/', 'Feat/DA-250-task', 'feature/DA-250-task', 'main', '-feat/task', 'feat/task/extra',
    'feat//task', 'feat/../task', 'feat/task..name', 'feat/task.lock', 'feat/.hidden', 'feat/task.', 'feat/task@{1}',
    'feat/task name', 'feat/task\tname', 'feat/task\n', 'feat/task\r', 'feat/task\\name', 'feat/task:name',
    'feat/task?name', 'feat/task*name', 'feat/task[name', 'feat/$(touch marker)', 'feat/task;touch-marker']) refused(branch);
  refused(jiraBranch, 'outside-owner/product-data-apps');
  refused(jiraBranch, 'https://github.com/accor-hotels/product-data-apps');
  console.log('ok   dispatch preserves Jira branch and develop base, accepts lowercase branches, refuses malformed refs and unsupported repositories before side effects');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
