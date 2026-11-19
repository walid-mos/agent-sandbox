import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { releaseGit } from '../session/factory-release-git.mjs';
import { publishReviewedRelease } from '../session/factory-release.mjs';

const [root, sharedRecord, remote, clone, policy, source, scenario, mergeCommit] = process.argv.slice(2);
const { withRecord, readRecord } = await import(pathToFileURL(`${sharedRecord}/factory-records.mjs`));
const { bindReview, requireReview } = await import(pathToFileURL(`${sharedRecord}/factory-review.mjs`));
const proof = JSON.parse(readFileSync(`${root}/request.json`, 'utf8'));
const { repository, number, generation, base, head } = proof;
const checked = { repository, number, generation, base: 'main', branch: 'fixture-source', mergeBase: base, head,
  stage: 'checked', checks: [{ name: 'fixture-check', isPassed: true }] };
const git = releaseGit(clone, remote);
const sign = request => JSON.parse(execFileSync('python3', ['-B', policy, '--sign', source], { input: JSON.stringify(request) }));
let live = { state: 'OPEN', isDraft: false, baseRefName: 'main', baseRefOid: base, headRefOid: head };
const requireReady = (record, request) => {
  if (live.state !== 'OPEN' || live.isDraft || live.headRefOid !== record.head
      || `refs/heads/${live.baseRefName}` !== request.ref || live.baseRefOid !== request.base) throw new Error('review changed');
};
const authority = { repository, ref: proof.ref, git, requireReady, sign };
withRecord(checked, (_, save) => save(checked));
const reviewId = bindReview(checked);
withRecord(checked, (_, save) => {
  const current = requireReview(reviewId);
  requireReady(current, proof);
  return save({ ...current, stage: 'judged', verdict: 'PASS' });
});
const publish = overrides => withRecord(checked, (record, save) => publishReviewedRelease(record, save, { ...authority, ...overrides }));

if (scenario === 'squash-record') {
  withRecord(checked, (record, save) => {
    assert.equal(record.stage, 'judged');
    save({ ...record, stage: 'merged', mergeCommit });
  });
  process.stdout.write(JSON.stringify({ reviewId, review: readRecord(checked) }));
} else if (scenario === 'moved') {
  const raced = { ...git, publish(commit, request) {
    execFileSync('git', ['--git-dir', remote, 'update-ref', request.ref, head, base]);
    git.publish(commit, request);
  } };
  assert.throws(() => publish({ git: raced }), /stale info/);
  assert.equal(git.tip(proof.ref), head);
  const { commit } = readRecord(checked).release;
  assert.equal(execFileSync('git', ['--git-dir', remote, 'tag', '--list', `factory-reviewed/${commit}`], { encoding: 'utf8' }), '');
  assert.equal(readRecord(checked).stage, 'signed');
  assert.throws(() => publish(), /expected checked base/);
} else if (scenario === 'retargeted') {
  live = { ...live, baseRefName: 'elsewhere' };
  assert.throws(() => publish({ sign: () => assert.fail('retargeted review reached the signer') }), /review changed/);
  assert.equal(git.tip(proof.ref), base);
} else if (scenario === 'ambiguous') {
  const candidate = sign(proof);
  assert.equal(git.store(candidate), candidate.commit);
  git.publish(candidate.commit, proof);
  assert.throws(() => publish({ sign: () => assert.fail('unrecorded publication reached the signer') }), /expected checked base/);
  assert.equal(readRecord(checked).stage, 'judged');
} else if (scenario === 'recovered' || scenario === 'series') {
  const published = publish();
  assert.equal(published.stage, 'published');
  assert.equal(git.tip(proof.ref), published.release.commit);
  assert.deepEqual(published.release.request, proof);
  const evidence = `refs/tags/factory-reviewed/${published.release.commit}`;
  assert.equal(git.tip(evidence), proof.head);
  process.stdout.write(JSON.stringify({ reviewId, published, evidence }));
} else {
  let original;
  assert.throws(() => publish({ sign(request) {
    original = sign(request);
    throw new Error('fixture stopped after signing');
  } }), /fixture stopped after signing/);
  assert.equal(readRecord(checked).stage, 'judged');
  const evidence = `refs/tags/factory-reviewed/${original.commit}`;
  const updateEvidence = (...args) => execFileSync('git', ['--git-dir', remote, 'update-ref', ...args]);
  updateEvidence(evidence, base);
  assert.throws(() => publish(), /stale info|already exists/);
  assert.equal(git.tip(proof.ref), base);
  assert.equal(git.tip(evidence), base);
  updateEvidence('-d', evidence, base);
  const interrupted = { ...git, publish(commit, request) {
    git.publish(commit, request);
    throw new Error('fixture stopped after push');
  } };
  assert.throws(() => publish({ git: interrupted }), /fixture stopped after push/);
  assert.equal(readRecord(checked).release.commit, original.commit);
  live = { ...live, state: 'CLOSED' };
  assert.equal(git.tip(evidence), head);
  updateEvidence('-d', evidence, head);
  assert.throws(() => publish(), /must retain reviewed head/);
  updateEvidence(evidence, base);
  assert.throws(() => publish(), /must retain reviewed head/);
  assert.equal(readRecord(checked).stage, 'signed');
  updateEvidence(evidence, head, base);
  const published = publish({ sign: () => assert.fail('published candidate reached the signer again') });
  assert.equal(published.stage, 'published');
  assert.equal(git.tip(proof.ref), original.commit);
  assert.deepEqual(published.release.request, proof);
  process.stdout.write(JSON.stringify({ reviewId, published, evidence }));
}
