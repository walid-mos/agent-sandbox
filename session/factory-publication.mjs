import { isLandingPull, landingRepository, LANDING_BRANCH, requireLandingAuthority } from './factory-authority.mjs';
import { askFactory } from './factory-channel.mjs';
import { mergeReadback, pullFacts, requireActionable, requireReviewPolicy, squashMerge } from './factory-github.mjs';
import { landingGit } from './factory-mirror.mjs';
import { withRecord } from './factory-records.mjs';
import { queueReport } from './factory-reports.mjs';
import { beginSquashPublication, finishSquashPublication, isPendingSquash, PENDING } from './factory-squash-publication.mjs';
import { requireRecoveryReview, reviewSquashRecovery } from './factory-squash-recovery.mjs';

function authority(record) {
  requireLandingAuthority(record.repository);
  if (!isLandingPull(record)) throw new Error('factory: squash publication needs the enrolled repository and target.');
  return { repository: landingRepository, ref: `refs/heads/${LANDING_BRANCH}`, git: landingGit(), requireReady: requireActionable,
    readMerge: mergeReadback, sign: squashEvidence => askFactory('landing', { squashEvidence }), queueReport, recovery: reviewSquashRecovery };
}

function continuePublication(record, save, adapters) {
  const facts = adapters.readMerge(record);
  if (record.stage === PENDING && facts.state === 'open') {
    const request = record.squashPublication.request;
    if (facts.repository !== request.repository || facts.number !== request.number
        || facts.head !== request.head || facts.ref !== request.ref) {
      throw new Error('factory: the open PR no longer matches the saved merge intent.');
    }
    adapters.requireReady(record, request);
    if (adapters.git.tip(request.ref) !== request.base) throw new Error('factory: the target moved before the pending squash could be sent.');
    squashMerge(record);
    return finishSquashPublication(record, save, adapters);
  }
  return finishSquashPublication(record, save, { ...adapters, readMerge: () => facts });
}

export function startPublication(record, save) {
  const adapters = authority(record);
  const pending = beginSquashPublication(record, save, adapters);
  return continuePublication(pending, save, adapters);
}

export function finishPublication(pull) {
  return withRecord(pull, (record, save) => {
    if (!isPendingSquash(record)) return;
    requireReviewPolicy(record);
    return continuePublication(record, save, authority(record));
  });
}

export function reviewFacts(record) {
  if (!record.recoveryOf) return requireActionable(record);
  requireRecoveryReview(record, landingGit());
  const original = pullFacts(record);
  return { headRefName: record.head, baseRefName: record.base, title: original.title,
    body: `Recovery review of landed squash ${record.head} against its parent ${record.mergeBase}. Original reviewed head: ${record.recoveryOf.head}.\n\n${original.body ?? ''}` };
}
