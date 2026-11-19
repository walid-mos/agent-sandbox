import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const factory = fileURLToPath(new URL('./factory.mjs', import.meta.url));
export const head = '0123456789abcdef0123456789abcdef01234567';
export const otherHead = 'abcdef0123456789abcdef0123456789abcdef01';
export const checked = { repository: 'nextnodesolutions/agent-sandbox', number: 22, head, generation: 1, stage: 'checked', base: 'main', branch: 'fix/example', mergeBase: otherHead, checks: [{ name: 'check', isPassed: true }] };
export const ready = { number: checked.number, baseRefOid: otherHead, timelineItems: { nodes: [] }, state: 'OPEN', isDraft: false, headRefOid: head, headRefName: checked.branch, baseRefName: checked.base, mergeable: 'MERGEABLE' };
export const resolvedHead = 'fedcba9876543210fedcba9876543210fedcba98';
export const releaseBase = '0123456789abcdefabcdef0123456789abcdef01';
export const retargeted = { ...ready, baseRefName: 'release', baseRefOid: releaseBase };
const draftScan = [{ number: checked.number, headRefOid: head, isDraft: true }];

export function fixture(t, { facts = ready, scanFacts = draftScan } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'factory-review-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const callsFile = join(home, 'calls.jsonl');
  const failWakeFile = join(home, 'fail-wake');
  const lockFactsFile = join(home, 'lock-facts.json');
  const realFlock = execFileSync('which', ['flock'], { encoding: 'utf8' }).trim();
  const sandbox = encodeURIComponent('export const botId = "principal", owners = ["walid-mos"], sandbox = { factoryDurable: true };');
  const loader = `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) {
    if (specifier === './sandbox.mjs') return { url: 'data:text/javascript,${sandbox}', shortCircuit: true };
    return next(specifier, context);
  } });`;
  const loaderFlag = `--import=data:text/javascript,${encodeURIComponent(loader)}`;
  const reentryFile = join(home, 'reentry.json');
  const run = (args, liveFacts = facts, topics = ['factory']) => spawnSync(process.execPath,
    [loaderFlag, ...args], {
      encoding: 'utf8', env: { HOME: home, PATH: home, CALLS: callsFile, FACTS: JSON.stringify(liveFacts), TOPICS: JSON.stringify(topics), REENTRY: reentryFile, FAIL_WAKE: failWakeFile, SCAN_FACTS: JSON.stringify(scanFacts), REPOSITORY: checked.repository, LOCK_FACTS: lockFactsFile, FLOCK: realFlock },
    });
  const reconcile = () => {
    const requested = run([factory, 'reconcile']);
    assert.equal(requested.status, 0, requested.stderr);
    return run([factory, 'scan']);
  };
  const reenterOn = (match, command, ...args) => {
    writeFileSync(reentryFile, JSON.stringify({ match, args: [loaderFlag, ...command.split(' ').slice(2), ...args] }));
  };
  const fake = join(home, 'fake');
  writeFileSync(callsFile, '');
  writeFileSync(fake, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, unlinkSync } = require('node:fs');
const { basename } = require('node:path');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
if (command !== 'flock' || existsSync(process.env.LOCK_FACTS)) {
  appendFileSync(process.env.CALLS, JSON.stringify([command, ...args]) + '\\n');
}
if (command === 'pots' && args.includes('principal') && existsSync(process.env.FAIL_WAKE)) {
  unlinkSync(process.env.FAIL_WAKE);
  process.stderr.write('Fixture wake failure');
  process.exit(1);
}
const file = process.env.REENTRY;
if (existsSync(file)) {
  const reentry = JSON.parse(readFileSync(file, 'utf8'));
  if (reentry.match.every((part, index) => part === [command, ...args][index])) {
    unlinkSync(file);
    const isDraftScan = reentry.args.includes('--fixture-draft');
    const env = isDraftScan ? { ...process.env, FACTS: JSON.stringify({ ...JSON.parse(process.env.FACTS), isDraft: true }) } : process.env;
    const nested = spawnSync(process.execPath, reentry.args.filter(arg => arg !== '--fixture-draft'), { encoding: 'utf8', timeout: 5000, env });
    appendFileSync(process.env.CALLS, JSON.stringify(['reentry', nested.status, nested.stderr]) + '\\n');
  }
}
if (command === 'flock') {
  const lock = spawnSync(process.env.FLOCK, args, { stdio: ['ignore', 'inherit', 'inherit', 3] });
  if (lock.status === 0 && existsSync(process.env.LOCK_FACTS)) {
    appendFileSync(process.env.CALLS, JSON.stringify(['locked']) + '\\n');
  }
  process.exit(lock.status ?? 1);
}
if (command === 'gh' && args[1] === 'view') {
  const isAfterLock = readFileSync(process.env.CALLS, 'utf8').split('\\n').includes('["locked"]');
  const facts = isAfterLock && existsSync(process.env.LOCK_FACTS) ? readFileSync(process.env.LOCK_FACTS, 'utf8') : process.env.FACTS;
  process.stdout.write(facts);
}
if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') process.stdout.write(process.env.SCAN_FACTS);
if (command === 'gh' && args[0] === 'repo' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ nameWithOwner: process.env.REPOSITORY, repositoryTopics: [{ name: 'factory' }] }]));
}
if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
  if (args.includes('--paginate')) process.stdout.write(JSON.stringify([{ data: { repository: { pullRequests: { nodes: [] } } } }]));
  else {
    const active = existsSync(process.env.LOCK_FACTS) ? readFileSync(process.env.LOCK_FACTS, 'utf8') : process.env.FACTS;
    const owner = args.find(arg => arg.startsWith('owner=')).slice(6);
    const name = args.find(arg => arg.startsWith('name=')).slice(5);
    process.stdout.write(JSON.stringify({ data: { repository: { nameWithOwner: owner + '/' + name, isArchived: false, pullRequest: JSON.parse(active) } } }));
  }
} else if (command === 'gh' && args[0] === 'api') process.stdout.write(process.env.TOPICS);
if (command === 'docker') {
  if (args[0] === 'image' && args.includes('--format')) process.stdout.write('sha256:' + 'a'.repeat(64));
  if (args[0] === 'create') process.stdout.write('c'.repeat(64));
  if (args[0] === 'inspect' && args.includes('{{.State.Status}} {{.State.ExitCode}}')) process.stdout.write('exited 0');
}
if (command === 'git') {
  const verb = args[2];
  if (verb === 'diff' && !args.includes('--diff-filter=U')) process.stdout.write('Fixture diff');
  if (verb === 'rev-parse') process.stdout.write('${otherHead}');
  if (verb === 'rev-list') process.stdout.write('${resolvedHead} ${head} ${otherHead}');
  if (verb === 'merge-base' && args[3] === '${releaseBase}') process.stdout.write('${releaseBase}');
}
`, { mode: 0o700 });
  for (const name of ['gh', 'git', 'pots', 'flock', 'docker']) symlinkSync(fake, join(home, name));
  const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const changePullAtLock = facts => {
    writeFileSync(callsFile, '');
    writeFileSync(lockFactsFile, JSON.stringify(facts));
    return () => rmSync(lockFactsFile);
  };
  return { home, run, calls, reconcile, reenterOn, changePullAtLock, failNextReport: () => writeFileSync(failWakeFile, '') };
}

export function handoff({ run, calls }, record) {
  const reports = new URL('./factory-reports.mjs', import.meta.url);
  const records = new URL('./factory-records.mjs', import.meta.url);
  const state = new URL('./factory-state.mjs', import.meta.url);
  const checks = new URL('./factory-checks.mjs', import.meta.url);
  const repositories = new URL('./factory-repositories.mjs', import.meta.url);
  const result = run(['--input-type=module', '-e', `import { deliverWakes, queueFactoryWake } from ${JSON.stringify(reports)};
    import { withRecord } from ${JSON.stringify(records)};
    import { withJobs } from ${JSON.stringify(state)};
    import { effectiveCheckRevision } from ${JSON.stringify(checks)};
    import { hasChecks } from ${JSON.stringify(repositories)};
    const record = JSON.parse(process.argv[1]);
    const subject = { repository: record.repository, number: record.number, head: record.head, base: record.base,
      baseTip: record.mergeBase, transition: record.generation === 1 ? '' : 'ready-again', mergeable: record.stage === 'conflict' ? 'CONFLICTING' : 'MERGEABLE' };
    if (record.stage === 'checked' && hasChecks(record.repository)) subject.inputRevision = effectiveCheckRevision(record.repository);
    await withJobs(jobs => {
      const { id } = jobs.observe(subject);
      const current = { ...record, ...subject, generation: id };
      deliverWakes(withRecord(current, (_, save) => save(queueFactoryWake(current))));
    });`, JSON.stringify(record)]);
  assert.equal(result.status, 0, result.stderr);
  return reviewWakes({ calls }).at(-1).commands;
}

export function reviewWakes({ calls }) {
  return calls().filter(call => call[0] === 'pots' && call.includes('factory-watch')).map(call => JSON.parse(call.at(-1)));
}

export function action({ run }, command, ...arguments_) {
  const [, , entry, ...prefix] = command.split(' ');
  assert.equal(entry, factory);
  return run([entry, ...prefix, ...arguments_]);
}

export function expectRefusal(result, error) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, error);
}
