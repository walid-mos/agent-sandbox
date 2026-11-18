import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const factory = fileURLToPath(new URL('./factory.mjs', import.meta.url));
export const head = '0123456789abcdef0123456789abcdef01234567';
export const otherHead = 'abcdef0123456789abcdef0123456789abcdef01';
export const checked = { repository: 'walid-mos/agent-sandbox', number: 22, head, generation: 0, stage: 'checked', mergeBase: otherHead, checks: [{ name: 'check', isPassed: true }] };
export const ready = { state: 'OPEN', isDraft: false, headRefOid: head };

export function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'factory-review-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const callsFile = join(home, 'calls.jsonl');
  const failWakeFile = join(home, 'fail-wake');
  const sandbox = encodeURIComponent('export const botId = "principal", owners = ["walid-mos"];');
  const loader = `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) {
    if (specifier === './sandbox.mjs') return { url: 'data:text/javascript,${sandbox}', shortCircuit: true };
    return next(specifier, context);
  } });`;
  const loaderFlag = `--import=data:text/javascript,${encodeURIComponent(loader)}`;
  const scanFacts = { number: checked.number, headRefOid: head, isDraft: true };
  const reentryFile = join(home, 'reentry.json');
  const run = (args, facts = ready, topics = ['factory']) => spawnSync(process.execPath,
    [loaderFlag, ...args], {
      encoding: 'utf8', env: { HOME: home, PATH: home, CALLS: callsFile, FACTS: JSON.stringify(facts), TOPICS: JSON.stringify(topics), REENTRY: reentryFile, FAIL_WAKE: failWakeFile, SCAN_FACTS: JSON.stringify([scanFacts]), REPOSITORY: checked.repository },
    });
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
appendFileSync(process.env.CALLS, JSON.stringify([command, ...args]) + '\\n');
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
    const nested = spawnSync(process.execPath, reentry.args, { encoding: 'utf8', timeout: 5000 });
    appendFileSync(process.env.CALLS, JSON.stringify(['reentry', nested.status, nested.stderr]) + '\\n');
  }
}
if (command === 'gh' && args[1] === 'view') process.stdout.write(process.env.FACTS);
if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') process.stdout.write(process.env.SCAN_FACTS);
if (command === 'gh' && args[0] === 'repo' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ nameWithOwner: process.env.REPOSITORY, repositoryTopics: [{ name: 'factory' }] }]));
}
if (command === 'gh' && args[0] === 'api') process.stdout.write(process.env.TOPICS);
if (command === 'git') process.stdout.write('Fixture diff');
`, { mode: 0o700 });
  for (const name of ['gh', 'git', 'pots']) symlinkSync(fake, join(home, name));
  symlinkSync(execFileSync('which', ['flock'], { encoding: 'utf8' }).trim(), join(home, 'flock'));
  const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { home, run, calls, reenterOn, failNextReport: () => writeFileSync(failWakeFile, '') };
}

export function handoff({ run, calls }, record) {
  const reports = new URL('./factory-reports.mjs', import.meta.url);
  const records = new URL('./factory-records.mjs', import.meta.url);
  const result = run(['--input-type=module', '-e', `import { deliverWakes, queueFactoryWake } from ${JSON.stringify(reports)};
    import { withRecord } from ${JSON.stringify(records)};
    const record = JSON.parse(process.argv[1]);
    deliverWakes(withRecord(record, (_, save) => save(queueFactoryWake(record))));`, JSON.stringify(record)]);
  assert.equal(result.status, 0, result.stderr);
  const wake = calls().findLast(call => call.includes('factory-watch'));
  return JSON.parse(wake.at(-1)).commands;
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
