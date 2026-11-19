import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { action, checked, expectRefusal, factory, fixture, handoff, head, otherHead, ready } from './factory-review-fixture.mjs';

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

test('a verdict committed before escalation acquires the lock wins the transition', t => {
  const rig = fixture(t);
  const { verdict, escalate } = handoff(rig, checked);
  const notes = join(rig.home, 'race notes');
  writeFileSync(notes, 'A competing decision.');
  rig.reenterOn(['flock', '--exclusive'], verdict.replace(' VERDICT NOTES_FILE', ''), 'FAIL', notes);
  expectRefusal(action(rig, escalate.replace(' NOTE_FILE', ''), notes), /is failed/);
  assert.deepEqual(rig.calls().find(([command]) => command === 'reentry'), ['reentry', 0, '']);
  assert.equal(rig.calls().filter(call => call[0] === 'pots' && call.includes('principal')).length, 1);
});

test('a scan can hold the round before escalation acquires the lock', t => {
  const rig = fixture(t);
  const { escalate } = handoff(rig, checked);
  const notes = join(rig.home, 'scan notes');
  writeFileSync(notes, 'Both judges stopped.');
  rig.reenterOn(['flock', '--exclusive'], `with-vault node ${factory} scan`);
  expectRefusal(action(rig, escalate.replace(' NOTE_FILE', ''), notes), /is held/);
  assert.deepEqual(rig.calls().find(([command]) => command === 'reentry'), ['reentry', 0, '']);
  assert.equal(rig.calls().filter(([command]) => command === 'pots').length, 1);
});

test('checked escalation refuses a changed head or draft PR', t => {
  const rig = fixture(t);
  const { escalate } = handoff(rig, checked);
  const notes = join(rig.home, 'live notes');
  writeFileSync(notes, 'Both judges stopped.');
  const args = [...escalate.replace(' NOTE_FILE', '').split(' ').slice(2), notes];
  expectRefusal(rig.run(args, { ...ready, headRefOid: otherHead }), /this step covers/);
  expectRefusal(rig.run(args, { ...ready, isDraft: true }), /a draft/);
  assert.equal(rig.calls().filter(([command]) => command === 'pots').length, 1);
});

test('escalation reads live eligibility after taking the record lock', t => {
  const rig = fixture(t);
  const { escalate, show } = handoff(rig, checked);
  const notes = join(rig.home, 'lock wait notes');
  writeFileSync(notes, 'Both judges stopped.');
  const restoreReady = rig.changePullAtLock({ ...ready, isDraft: true });
  expectRefusal(action(rig, escalate.replace(' NOTE_FILE', ''), notes), /a draft/);
  assert.deepEqual(rig.calls().map(([command]) => command), ['flock', 'locked', 'gh']);
  restoreReady();
  assert.match(action(rig, show).stdout, new RegExp(`Head ${head}`));
});

test('an escalation notification can re-enter and sees the committed stage', t => {
  const rig = fixture(t);
  const { verdict, escalate } = handoff(rig, checked);
  const notes = join(rig.home, 'reentry notes');
  writeFileSync(notes, 'Both judges stopped.');
  rig.reenterOn(['pots', 'wake', '--bot', 'principal'], verdict.replace(' VERDICT NOTES_FILE', ''), 'FAIL', notes);
  assert.equal(action(rig, escalate.replace(' NOTE_FILE', ''), notes).status, 0);
  const [, status, error] = rig.calls().find(([command]) => command === 'reentry');
  assert.equal(status, 1, error);
  assert.match(error, /is escalated/);
  assert.equal(rig.calls().filter(([, , verb]) => verb === 'comment').length, 0);
});

test('notification acknowledgement preserves a record changed by re-entry', t => {
  const rig = fixture(t);
  const { escalate, show } = handoff(rig, checked);
  const notes = join(rig.home, 'reentry scan notes');
  writeFileSync(notes, 'Both judges stopped.');
  rig.reenterOn(['pots', 'wake', '--bot', 'principal'], `with-vault node ${factory} scan`);
  const result = action(rig, escalate.replace(' NOTE_FILE', ''), notes);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(rig.calls().find(([command]) => command === 'reentry'), ['reentry', 0, '']);
  expectRefusal(action(rig, show), /is held/);
  const reports = rig.calls().filter(call => call[0] === 'pots' && call.includes('principal'));
  assert.equal(reports.length, 2);
  assert.equal(reports[1][reports[1].indexOf('--id') + 1], reports[0][reports[0].indexOf('--id') + 1]);
});

test('scan retries a failed notification without repeating the transition', t => {
  const rig = fixture(t);
  const { escalate, show } = handoff(rig, checked);
  const notes = join(rig.home, 'delivery notes');
  writeFileSync(notes, 'Both judges stopped.');
  rig.failNextReport();
  expectRefusal(action(rig, escalate.replace(' NOTE_FILE', ''), notes), /Fixture wake failure/);
  expectRefusal(action(rig, show), /is escalated/);
  assert.equal(rig.run([factory, 'scan']).status, 0);
  assert.equal(rig.run([factory, 'scan']).status, 0);
  const reports = rig.calls().filter(call => call[0] === 'pots' && call.includes('principal'));
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0], reports[1]);
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
  expectRefusal(submit({ ...ready, baseRefName: 'release' }), /now targets release/);
  expectRefusal(submit(ready, []), /no longer has the factory topic/);
  const unconfigured = handoff(rig, { ...checked, repository: 'walid-mos/unconfigured' });
  expectRefusal(action(rig, unconfigured.verdict.replace(' VERDICT NOTES_FILE', ''), 'PASS'), /defines no checks/);
  assert.deepEqual(rig.calls().filter(([, , verb]) => verb === 'comment' || verb === 'merge'), []);
});
