import { isDeepStrictEqual } from 'node:util';
import { releaseRequest } from './factory-release.mjs';

export const PENDING = 'squash-pending';
const OBSERVED = 'squash-observed';
const SIGNED = 'squash-signed';
export const isPendingSquash = record => [PENDING, OBSERVED, SIGNED].includes(record?.stage);
const PUBLISHED = 'published';
const COMMIT_ID = /^[a-f0-9]{40}$/;

export function beginSquashPublication(record, save, authority) {
  if (record.stage !== 'judged') throw new Error('factory: native squash needs a judged review.');
  const request = releaseRequest(record, authority);
  authority.requireReady(record, request);
  if (authority.git.tip(request.ref) !== request.base) throw new Error('factory: the target moved after review.');
  return save({ ...record, stage: PENDING, squashPublication: { request } });
}

function observeMerge(record, request, authority) {
  const facts = authority.readMerge(record);
  const { repository, number, head, ref } = request;
  const squash = facts?.squash;
  if (typeof squash !== 'string' || !COMMIT_ID.test(squash)
      || !isDeepStrictEqual(facts, { repository, number, head, ref, state: 'MERGED', squash })) {
    throw new Error('factory: merge readback must match the checked repository, PR, head and target.');
  }
  const observed = record.squashPublication.squash;
  if (observed !== undefined && observed !== squash) throw new Error('factory: the recorded squash differs from merge readback.');
  return squash;
}

function hasCurrentInputs(record, authority) {
  if (!authority.currentInputRevision) return true;
  return Boolean(record.inputRevision && record.inputRevision === authority.currentInputRevision(record.repository));
}

function requireOperatorRecovery(record, save, authority) {
  const { landed } = record.squashPublication;
  const disposition = { ...record, stage: 'squash-recovery-required' };
  return save(authority.queueReport(disposition,
    `PR factory paused publication for ${record.repository}#${record.number} at landed squash ${landed.head} because check inputs changed. The operator must review the recorded parent and tree with current checks before certifying this squash.`));
}

function publishEvidence(record, save, request, authority) {
  const release = record.stage === SIGNED ? record.squashPublication.release : authority.sign(request);
  const tag = authority.git.storeSquashEvidence(release, request);
  const signed = record.stage === SIGNED ? record
    : save({ ...record, stage: SIGNED, squashPublication: { ...record.squashPublication, release } });
  if (!hasCurrentInputs(signed, authority)) return requireOperatorRecovery(signed, save, authority);
  authority.git.publishSquashEvidence(tag, request);
  return signed;
}

export function finishSquashPublication(record, save, authority) {
  if (record.stage === PUBLISHED && record.squashPublication?.release) return record;
  if (!isPendingSquash(record)) throw new Error('factory: no bound native squash is pending.');
  const request = releaseRequest(record, authority);
  if (!isDeepStrictEqual(record.squashPublication?.request, request)) throw new Error('factory: the saved squash intent differs from the approved review.');
  const squash = observeMerge(record, request, authority);
  const landed = authority.git.inspectSquash(squash, request.ref);
  const raced = landed.base !== request.base || landed.tree !== request.tree;
  if (raced && !authority.recovery) authority.git.requireLandedSquash(squash, request);
  const observed = record.stage === PENDING ? save({ ...record, stage: OBSERVED, squashPublication: { request, squash, landed } }) : record;
  if (!isDeepStrictEqual(observed.squashPublication.landed, landed)) throw new Error('factory: the saved landed tuple differs from Git.');
  if (!hasCurrentInputs(observed, authority)) return requireOperatorRecovery(observed, save, authority);
  const evidence = raced ? authority.recovery(observed, landed) : { ...request, squash };
  if (!evidence) return observed;
  const signed = publishEvidence(observed, save, evidence, authority);
  if (signed.stage !== SIGNED) return signed;
  const published = { ...signed, stage: PUBLISHED, mergeCommit: squash };
  return save(authority.queueReport(published, `PR factory verified ${request.repository}#${request.number} merged into ${record.base} as ${squash} and confirmed its signed release evidence.`));
}
