import { askFactory } from './factory-channel.mjs';
import { isLandingPull, LANDING_BRANCH, requireLandingAuthority } from './factory-authority.mjs';
import { branchTip, pushCommit, refreshMirror, writeCommit } from './factory-mirror.mjs';
import { pullUrl, writeRecord } from './factory-records.mjs';
import { reportToPrincipal } from './factory-reports.mjs';

function publishLanding(repository, release) {
  refreshMirror(repository);
  const commit = writeCommit(repository, Buffer.from(release.object, 'base64'));
  if (commit !== release.commit) throw new Error('factory: the signed object does not match the signer receipt. Nothing was pushed.');
  pushCommit(repository, commit, LANDING_BRANCH);
  refreshMirror(repository);
  if (branchTip(repository, LANDING_BRANCH) !== commit) throw new Error(`factory: signed publication is not the remote ${LANDING_BRANCH} tip. Installation is unconfirmed.`);
}

export function finishPublication(record) {
  requireLandingAuthority(record.repository);
  publishLanding(record.repository, record.release);
  return reportToPrincipal({ ...record, stage: 'published' },
    `PR factory merged ${pullUrl(record)} as ${record.mergeCommit}, signed landing commit ${record.release.commit} with ${record.release.fingerprint}, and published it to ${LANDING_BRANCH}. Receiver installation is not yet observed. The Mac continues waiting for an operator-signed tip.`);
}

export function signPublication(record, facts) {
  if (!isLandingPull(record)) return reportToPrincipal({ ...record, stage: 'merged', mergeCommit: facts.mergeCommit?.oid }, `PR factory merged ${pullUrl(record)} into ${facts.baseRefName} as ${facts.mergeCommit?.oid}, after a ${record.verdict} verdict on head ${record.head}.`);
  requireLandingAuthority(record.repository);
  const merged = facts.mergeCommit?.oid;
  if (!merged || facts.headRefOid !== record.head || facts.baseRefName !== LANDING_BRANCH) {
    throw new Error('factory: the merged pull request does not match the checked release. Nothing was signed.');
  }
  const release = askFactory('landing', { repository: record.repository, number: record.number, head: record.head, merged, base: record.releaseBase });
  const signed = writeRecord({ ...record, stage: 'signed', mergeCommit: merged, release });
  return finishPublication(signed);
}
