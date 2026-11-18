import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const factory = fileURLToPath(new URL('./factory.mjs', import.meta.url));
const head = '0123456789abcdef0123456789abcdef01234567';
const otherHead = 'abcdef0123456789abcdef0123456789abcdef01';
const checked = { repository: 'walid-mos/agent-sandbox', number: 22, head, generation: 0, stage: 'checked', mergeBase: otherHead, checks: [{ name: 'check', isPassed: true }] };
const ready = { state: 'OPEN', isDraft: false, headRefOid: head };

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'factory-review-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const callsFile = join(home, 'calls.jsonl');
  const sandbox = encodeURIComponent('export const botId = "principal", owners = [];');
  const loader = `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) {
    if (specifier === './sandbox.mjs') return { url: 'data:text/javascript,${sandbox}', shortCircuit: true };
    return next(specifier, context);
  } });`;
  const run = (args, facts = ready, topics = ['factory']) => spawnSync(process.execPath,
    [`--import=data:text/javascript,${encodeURIComponent(loader)}`, ...args], {
      encoding: 'utf8', env: { HOME: home, PATH: home, CALLS: callsFile, FACTS: JSON.stringify(facts), TOPICS: JSON.stringify(topics) },
    });
  const fake = join(home, 'fake');
  writeFileSync(callsFile, '');
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify([command, ...args]) + '\\n');
if (command === 'gh' && args[1] === 'view') process.stdout.write(process.env.FACTS);
if (command === 'gh' && args[0] === 'api') process.stdout.write(process.env.TOPICS);
if (command === 'git') process.stdout.write('Fixture diff');
`, { mode: 0o700 });
  for (const name of ['gh', 'git', 'pots']) symlinkSync(fake, join(home, name));
  const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { home, run, calls };
}

function handoff({ run, calls }, record) {
  const reports = new URL('./factory-reports.mjs', import.meta.url);
  const result = run(['--input-type=module', '-e', `import { handToFactory } from ${JSON.stringify(reports)};
    handToFactory(JSON.parse(process.argv[1]));`, JSON.stringify(record)]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(calls().at(-1).at(-1)).commands;
}

function action({ run }, command, ...arguments_) {
  const [, , entry, ...prefix] = command.split(' ');
  assert.equal(entry, factory);
  return run([entry, ...prefix, ...arguments_]);
}

function expectRefusal(result, error) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, error);
}

test('the checked wake binds show and verdict to the exact attempt', t => {
  const rig = fixture(t);
  const { show, verdict } = handoff(rig, checked);
  for (const command of [show, verdict]) {
    const args = command.split(' ').slice(3);
    for (const value of [checked.repository, String(checked.number), head, String(checked.generation)]) {
      assert.ok(!args.includes(value), `wake command includes raw review argument ${value}`);
    }
  }
  assert.match(action(rig, show).stdout, new RegExp(`Head ${head}`));
  const notes = join(rig.home, 'review notes');
  writeFileSync(notes, 'Fixture failure');
  const refused = action(rig, verdict.replace(' VERDICT NOTES_FILE', ''), 'FAIL', notes, otherHead);
  expectRefusal(refused, /decision and optional notes file/);
  expectRefusal(rig.run([factory, 'verdict', checked.repository, String(checked.number), head, 'PASS']), /usage:/);
  const submission = action(rig, verdict.replace(' VERDICT NOTES_FILE', ''), 'FAIL', notes);
  assert.equal(submission.status, 0, submission.stderr);
  assert.match(submission.stdout, new RegExp(`/pull/22 at ${head}: failed`));
  expectRefusal(action(rig, verdict.replace(' VERDICT NOTES_FILE', ''), 'FAIL', notes), /is failed/);
  assert.deepEqual(rig.calls().filter(([, , verb]) => verb === 'comment' || verb === 'merge').map(call => call.slice(0, 6)),
    [['gh', 'pr', 'comment', '22', '--repo', checked.repository]]);
});

test('a checked record alone cannot authorize a verdict without its wake binding', t => {
  const rig = fixture(t);
  const { verdict } = handoff(rig, checked);
  const prefix = verdict.replace(' VERDICT NOTES_FILE', '');
  const [, id] = prefix.split(' ').slice(3);
  const binding = join(rig.home, '.config', 'agent-sandbox', 'factory', 'reviews', `${id}.json`);
  const before = rig.calls();
  writeFileSync(binding, JSON.stringify({ ...checked, number: 23 }));
  expectRefusal(action(rig, prefix, 'PASS'), /no matching review binding/);
  rmSync(binding);
  expectRefusal(action(rig, prefix, 'PASS'), /no matching review binding/);
  assert.deepEqual(rig.calls(), before);
});

test('a second round on the same head rejects the first round verdict', t => {
  const rig = fixture(t);
  const first = handoff(rig, checked).verdict.replace(' VERDICT NOTES_FILE', '');
  const second = handoff(rig, { ...checked, generation: 1 }).verdict.replace(' VERDICT NOTES_FILE', '');
  assert.notEqual(first, second);
  const before = rig.calls();
  expectRefusal(action(rig, first, 'PASS'), /no longer matches/);
  assert.deepEqual(rig.calls(), before);
  assert.match(action(rig, second, 'PASS').stdout, /refused/);
  assert.deepEqual(rig.calls().find(([, , verb]) => verb === 'merge'),
    ['gh', 'pr', 'merge', '22', '--repo', checked.repository, '--squash', '--match-head-commit', head]);
  expectRefusal(action(rig, second, 'PASS'), /is refused/);
});

test('an older review cannot escalate a superseded same-head generation', t => {
  const rig = fixture(t);
  const first = handoff(rig, checked);
  handoff(rig, { ...checked, generation: 1 });
  const notes = join(rig.home, 'retry notes');
  writeFileSync(notes, 'The judge stopped before deciding.');
  const before = rig.calls();
  expectRefusal(action(rig, first.escalate.replace(' NOTE_FILE', ''), notes), /checked record no longer matches/);
  const legacy = rig.run([factory, 'escalate', checked.repository, String(checked.number), head, notes]);
  expectRefusal(legacy, /needs it conflict/);
  assert.deepEqual(rig.calls(), before);
});

test('a completed verdict cannot be overwritten by its review escalation', t => {
  const rig = fixture(t);
  const { verdict, escalate } = handoff(rig, checked);
  const notes = join(rig.home, 'terminal notes');
  writeFileSync(notes, 'The judge stopped before deciding.');
  assert.equal(action(rig, verdict.replace(' VERDICT NOTES_FILE', ''), 'FAIL', notes).status, 0);
  const before = rig.calls();
  expectRefusal(action(rig, escalate.replace(' NOTE_FILE', ''), notes), /is failed/);
  assert.deepEqual(rig.calls(), before);
});

test('the current checked review can escalate and close its round', t => {
  const rig = fixture(t);
  const { escalate, show } = handoff(rig, { ...checked, generation: 1 });
  const notes = join(rig.home, 'retry notes');
  writeFileSync(notes, 'Both judges stopped before deciding.');
  const result = action(rig, escalate.replace(' NOTE_FILE', ''), notes);
  assert.equal(result.status, 0, result.stderr);
  assert.match(rig.calls().at(-1).at(-1), /Both judges stopped before deciding/);
  expectRefusal(action(rig, show), /is escalated/);
});

test('conflict escalation retains its repository and head command', t => {
  const rig = fixture(t);
  const { escalate } = handoff(rig, { ...checked, stage: 'conflict' });
  assert.match(escalate, /escalate walid-mos\/agent-sandbox 22 0123456789abcdef0123456789abcdef01234567 NOTE_FILE/);
  const notes = join(rig.home, 'conflict notes');
  writeFileSync(notes, 'Principal must resolve the conflict.');
  assert.equal(action(rig, escalate.replace(' NOTE_FILE', ''), notes).status, 0);
});

test('bound actions still refuse a changed head, draft, closed PR, or removed topic', t => {
  const rig = fixture(t);
  const { verdict } = handoff(rig, checked);
  const [, , entry, ...prefix] = verdict.replace(' VERDICT NOTES_FILE', '').split(' ');
  const submit = (facts, topics) => rig.run([entry, ...prefix, 'PASS'], facts, topics);
  expectRefusal(submit({ ...ready, headRefOid: otherHead }), /this step covers/);
  expectRefusal(submit({ ...ready, isDraft: true }), /a draft/);
  expectRefusal(submit({ ...ready, state: 'CLOSED' }), /CLOSED/);
  expectRefusal(submit(ready, []), /no longer has the factory topic/);
  const unconfigured = handoff(rig, { ...checked, repository: 'walid-mos/unconfigured' });
  expectRefusal(action(rig, unconfigured.verdict.replace(' VERDICT NOTES_FILE', ''), 'PASS'), /defines no checks/);
  assert.deepEqual(rig.calls().filter(([, , verb]) => verb === 'comment' || verb === 'merge'), []);
});
