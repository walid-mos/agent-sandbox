import { isDeepStrictEqual } from 'node:util';
import { requireLandingAuthority } from './factory-authority.mjs';
import { effectiveCheckRevision, probe, runLegacyChecks } from './factory-checks.mjs';
import { mergeReadback, requireReviewPolicy } from './factory-github.mjs';
import { refreshMirror } from './factory-mirror.mjs';
import { logDirectory, readRecord, withRecord } from './factory-records.mjs';
import { deliverWakes, queueFactoryWake, queueReport } from './factory-reports.mjs';
import { isPendingSquash } from './factory-squash-publication.mjs';

function recoverySubject(original, landed) {
  const { repository, number, base, branch, generation, head } = original;
  return { repository, number, base, branch, generation, head: landed.head,
    mergeBase: landed.base, tree: landed.tree, recoveryOf: { head, generation } };
}

function createReview(subject) {
  probe();
  refreshMirror(subject.repository);
  const inputRevision = effectiveCheckRevision(subject.repository);
  const checks = runLegacyChecks(subject, subject.mergeBase, logDirectory(subject));
  if (effectiveCheckRevision(subject.repository) !== inputRevision) throw new Error('factory: recovery check inputs changed');
  subject = { ...subject, inputRevision };
  if (!checks.length || !checks.every(check => check.isPassed === true)) {
    return queueReport({ ...subject, stage: 'checks-failed', checks },
      `PR factory cannot certify squash ${subject.head}. Its landed tree checks did not pass.`);
  }
  return queueFactoryWake({ ...subject, stage: 'checked', checks });
}

export function reviewSquashRecovery(original, landed) {
  const subject = recoverySubject(original, landed);
  const review = withRecord(subject, (current, save) => current ?? save(createReview(subject)));
  if (!Object.entries(subject).every(([key, value]) => isDeepStrictEqual(review[key], value))) {
    throw new Error('factory: the recovery review differs from the recorded squash.');
  }
  deliverWakes(review);
  if (review.inputRevision !== effectiveCheckRevision(review.repository)) throw new Error('factory: recovery proof inputs changed');
  if (review.stage !== 'judged' || !['PASS', 'PASS+NOTES'].includes(review.verdict)
      || !review.checks?.length || !review.checks.every(check => check.isPassed === true)) return;
  return { original: original.squashPublication.request, landed: { ...landed, generation: review.generation } };
}

export function requireRecoveryReview(review, git) {
  requireLandingAuthority(review.repository);
  requireReviewPolicy(review);
  const original = readRecord({ ...review, head: review.recoveryOf.head });
  const landed = original?.squashPublication?.landed;
  if (!isPendingSquash(original) || original.generation !== review.recoveryOf.generation || !landed
      || !Object.entries(recoverySubject(original, landed)).every(([key, value]) => isDeepStrictEqual(review[key], value))) {
    throw new Error('factory: recovery requires the bound original merge attempt.');
  }
  const facts = mergeReadback(original);
  const expected = { repository: original.repository, number: original.number, head: original.head,
    ref: original.squashPublication.request.ref, state: 'MERGED', squash: landed.head };
  if (!isDeepStrictEqual(facts, expected) || !isDeepStrictEqual(git.inspectSquash(landed.head, facts.ref), landed)) {
    throw new Error('factory: the merged PR or landed recovery tuple changed.');
  }
  return facts;
}
