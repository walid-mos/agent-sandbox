import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { action, checked, expectRefusal, factory, fixture, handoff, head, otherHead, ready, releaseBase, resolvedHead, retargeted, reviewWakes } from './factory-review-fixture.mjs';

const conflict = { ...checked, stage: 'conflict' };
const conflicting = { ...ready, mergeable: 'CONFLICTING' };
const retargetedListing = [{ ...retargeted, number: checked.number }];

function withLivePull(rig, facts) {
  return { run: args => rig.run(args, facts) };
}

test('conflict resolve uses the saved target and refuses an actual retarget', t => {
  const rig = fixture(t, { facts: conflicting });
  const { resolve } = handoff(rig, conflict);
  expectRefusal(action(withLivePull(rig, { ...retargeted, mergeable: 'CONFLICTING' }), resolve), /no longer matches this review generation/);
  assert.ok(!rig.calls().some(([command]) => command === 'git'));

  const result = action(rig, resolve);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Merging main at /);
  assert.ok(rig.calls().some(([command, , , verb, ...args]) => command === 'git' && verb === 'merge' && args.includes(otherHead)));
});

test('conflict push uses the saved target and refuses an actual retarget', t => {
  const rig = fixture(t, { facts: conflicting });
  const workspace = join(rig.home, 'resolution');
  const { push } = handoff(rig, { ...conflict, resolution: { workspace, branch: checked.branch, baseTip: otherHead, files: [] } });
  const pushes = () => rig.calls().filter(([command, , , verb]) => command === 'git' && verb === 'push');
  expectRefusal(action(withLivePull(rig, { ...retargeted, mergeable: 'CONFLICTING' }), push), /no longer matches this review generation/);
  assert.deepEqual(pushes(), []);

  const result = action(rig, push);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`pushed ${resolvedHead}`));
  assert.deepEqual(pushes(), [['git', '-C', workspace, 'push', '--quiet', 'origin', 'HEAD:refs/heads/fix/example']]);
  expectRefusal(action(rig, push), /is resolved/);
});

test('a ready same-head retarget gets fresh checks and invalidates old replies', t => {
  const rig = fixture(t, { facts: retargeted, scanFacts: retargetedListing });
  const previous = handoff(rig, checked);
  const notes = join(rig.home, 'notes');
  writeFileSync(notes, 'Review stopped.');
  const verdict = previous.verdict.replace(' VERDICT NOTES_FILE', '');
  const escalate = previous.escalate.replace(' NOTE_FILE', '');
  expectRefusal(action(rig, verdict, 'PASS'), /no longer matches this review generation/);
  expectRefusal(action(rig, escalate, notes), /no longer matches this review generation/);

  const result = rig.reconcile();
  assert.equal(result.status, 0, result.stderr);
  for (const operation of ['run-job', 'publish-job']) {
    const step = rig.run([factory, operation, '2']);
    assert.equal(step.status, 0, step.stderr);
  }
  const wakes = reviewWakes(rig);
  assert.deepEqual(wakes.map(({ event, head, generation, base, mergeBase }) => [event, head, generation, base, mergeBase]), [
    ['checked', head, 1, 'main', otherHead], ['checked', head, 2, 'release', releaseBase],
  ]);
  assert.ok(rig.calls().some(([command, ...args]) => command === 'docker' && args.includes(releaseBase)));
  const before = rig.calls();
  expectRefusal(action(rig, verdict, 'PASS'), /current review generation/);
  expectRefusal(action(rig, escalate, notes), /current review generation/);
  assert.deepEqual(rig.calls(), before);
  const show = action(rig, wakes[1].commands.show);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`into release from merge base ${releaseBase}`));
  assert.equal(rig.run([factory, 'scan']).status, 0);
  assert.equal(reviewWakes(rig).length, 2);
});

test('a stale listing cannot replace the checked review after the target changes back', t => {
  const rig = fixture(t, { facts: retargeted, scanFacts: retargetedListing });
  const { show } = handoff(rig, checked);
  const restore = rig.changePullAtLock(ready);
  const result = rig.reconcile();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(reviewWakes(rig), []);
  assert.ok(rig.calls().some(([command, verb, endpoint]) => command === 'gh' && verb === 'api' && endpoint === 'graphql'));
  restore();
  const current = action(withLivePull(rig, ready), show);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /into main/);
});
