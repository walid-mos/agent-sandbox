import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [checkout, scratch, phase] = process.argv.slice(2);
const owner = 'probe';
const repository = `${owner}/worker`;
const branches = { before: 'feat/resume', fresh: 'feat/fresh', client: 'feat/client' };
const workspace = join(scratch, 'Development', repository);
const remote = join(scratch, 'worker.git');
const clientRules = join(scratch, 'client-rules.md');
const rulesText = 'Ask the person before every push.';
const request = join(scratch, 'request.md');
const binaries = join(scratch, 'bin');
const preloader = join(scratch, 'sandbox-mock.mjs');
const launchLog = join(scratch, 'launch-arguments');
const workerRecords = join(scratch, '.config/agent-sandbox/workers');
const savedWorker = join(scratch, 'saved-worker.json');
const policy = join(checkout, 'docs/human-dialogs.md');
const routinePolicy = 'Routine feature-branch pushes need no human approval unless an applicable rule requires it.';
const environment = {
  ...process.env, HOME: scratch, PATH: `${binaries}:${process.env.PATH}`, GIT_ALLOW_PROTOCOL: 'file',
  PROBE_CHECKOUT: checkout, PROBE_LAUNCH_LOG: launchLog, PROBE_OWNER: owner,
};

function run(binary, args, options = {}) {
  return execFileSync(binary, args, { encoding: 'utf8', env: environment, timeout: 15_000, ...options }).trim();
}

function prepare() {
  const piAgent = join(scratch, '.pi/agent');
  const draft = join(piAgent, 'skills/worktree/scripts/draft-pr');
  const subagent = join(piAgent, 'extensions/subagent');
  mkdirSync(scratch, { mode: 0o700 });
  for (const directory of [binaries, dirname(workspace), dirname(draft), subagent]) {
    mkdirSync(directory, { recursive: true });
  }
  run('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  run('git', ['clone', '--quiet', remote, workspace]);
  run('git', ['-C', workspace, 'config', 'user.name', 'Worker Fixture']);
  run('git', ['-C', workspace, 'config', 'user.email', 'worker@example.invalid']);
  run('git', ['-C', workspace, 'commit', '--quiet', '--allow-empty', '-m', 'Seed']);
  run('git', ['-C', workspace, 'push', '--quiet', 'origin', 'main']);
  writeFileSync(join(subagent, 'config.json'), JSON.stringify({ worktreeBaseDir: '.worktree' }));
  writeFileSync(request, 'Prepare a routine topic-branch change.');
  writeFileSync(clientRules, rulesText);
  writeFileSync(draft, `set -eu
git push --quiet origin HEAD
printf '%s\n' 'https://github.invalid/probe/pull/1'
`);
  writeFileSync(join(binaries, 'pi'), '#!/bin/sh\n[ "$1" = --help ]\n', { mode: 0o700 });
  writeFileSync(join(binaries, 'hc'), `#!/bin/sh
case "$1" in
  run) printf '%s\n' "$@" > "$PROBE_LAUNCH_LOG" ;;
  get) printf '%s\n' '{"address":"fixture-terminal"}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  writeFileSync(preloader, `import { join } from 'node:path';
import { mock } from 'node:test';
const { PROBE_CHECKOUT, PROBE_CLIENT_RULES, PROBE_OWNER } = process.env;
const sandbox = { bot: 'Probe', maxWorkers: 1, rules: PROBE_CLIENT_RULES, humanDiscord: { pushApprovalsEnabled: false } };
mock.module(join(PROBE_CHECKOUT, 'session/sandbox.mjs'), {
  exports: { sandbox, owners: [PROBE_OWNER], botId: PROBE_OWNER },
});
`);
}

function node(args, extraEnvironment = {}) {
  return run(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks',
    '--import', preloader, ...args], { env: { ...environment, ...extraEnvironment } });
}

function serve() {
  node(['--input-type=module', '-e', `
    import { pathToFileURL } from 'node:url';
    const { serveQueue } = await import(pathToFileURL(process.argv[1]));
    serveQueue([], (_worker, error) => { throw error; });
  `, join(checkout, 'session/serve-queue.mjs')]);
  const arguments_ = readFileSync(launchLog, 'utf8').trimEnd().split('\n');
  assert.equal(arguments_[arguments_.indexOf('--extension') + 1], join(checkout, 'session/worker-agent.mjs'));
  return arguments_;
}

function dispatch(branch, extraEnvironment) {
  const output = node([join(checkout, 'session/dispatch.mjs'), 'start', '--title', 'Fixture branch',
    '--subject', 'Fixture bootstrap', '--', repository, branch, request, 'main'], extraEnvironment);
  const worker = JSON.parse(output);
  const bootstrapCommit = run('git', ['-C', worker.worktree, 'rev-parse', 'HEAD']);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]), bootstrapCommit);
  assert.ok(serve().includes(`@${worker.brief}`));
  return worker;
}

function startBeforeActivation() {
  prepare();
  const worker = dispatch(branches.before);
  const brief = readFileSync(worker.brief, 'utf8');
  assert.ok(!brief.includes(policy));
  assert.ok(!readFileSync(policy, 'utf8').includes(routinePolicy));
  const record = join(workerRecords, `${worker.name}.json`);
  const started = JSON.parse(readFileSync(record, 'utf8'));
  const sessionFile = join(started.sessionDir, 'original.jsonl');
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: started.sessionId })}\n${JSON.stringify({
    type: 'message', message: { role: 'user', content: brief },
  })}\n`);
  writeFileSync(record, JSON.stringify({ ...started, sessionFile }));
  writeFileSync(savedWorker, JSON.stringify({ ...worker, sessionFile, brief }));
  return { phase, oldBriefNamesPushPolicy: false };
}

function resumeAfterActivation() {
  const saved = JSON.parse(readFileSync(savedWorker, 'utf8'));
  node([join(checkout, 'session/dispatch.mjs'), 'send', saved.name, request]);
  const arguments_ = serve();
  assert.equal(arguments_[arguments_.indexOf('--session') + 1], saved.sessionFile);
  assert.equal(JSON.parse(readFileSync(saved.sessionFile, 'utf8').split('\n')[1]).message.content, saved.brief);
  return { saved, prompt: promptOf(arguments_) };
}

function promptOf(arguments_) {
  const index = arguments_.indexOf('--append-system-prompt');
  return index < 0 ? '' : arguments_[index + 1];
}

function publishRoutine(worker) {
  run('git', ['-C', worker.worktree, 'commit', '--quiet', '--allow-empty', '-m', 'Routine worker change']);
  run('git', ['-C', worker.worktree, 'push', '--quiet', 'origin', 'HEAD']);
  const head = run('git', ['-C', worker.worktree, 'rev-parse', 'HEAD']);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${worker.branch}`]), head);
  return head;
}

function startAfterActivation() {
  assert.ok(readFileSync(policy, 'utf8').includes(routinePolicy));
  const fresh = dispatch(branches.fresh);
  const freshPrompt = promptOf(readFileSync(launchLog, 'utf8').trimEnd().split('\n'));
  const client = dispatch(branches.client, { PROBE_CLIENT_RULES: clientRules });
  const freshBrief = readFileSync(fresh.brief, 'utf8');
  const clientBrief = readFileSync(client.brief, 'utf8');
  assert.ok(freshBrief.includes(policy));
  assert.ok(!freshBrief.includes(clientRules));
  assert.ok(clientBrief.includes(policy) && clientBrief.includes(clientRules));
  assert.ok(!clientBrief.includes(rulesText));
  assert.equal(readFileSync(clientRules, 'utf8'), rulesText);
  const { saved, prompt } = resumeAfterActivation();
  if (process.env.FACTORY_RELEASE_REQUIRE_RESUME_POLICY === '1') {
    for (const instructions of [freshPrompt, prompt]) {
      assert.ok(instructions.includes(policy));
      assert.ok(instructions.includes('configured client rules'));
    }
  }
  const routinePushes = prompt ? [publishRoutine(fresh), publishRoutine(saved)] : [];
  return { phase, resumedOriginalSession: true, resumeHasPromptOverride: Boolean(prompt), freshReferencesPolicy: true,
    clientReferencesRules: true, localBootstrapPushes: [branches.before, branches.fresh, branches.client], routinePushes };
}

assert.ok(['before', 'after'].includes(phase));
console.log(JSON.stringify(phase === 'before' ? startBeforeActivation() : startAfterActivation()));
