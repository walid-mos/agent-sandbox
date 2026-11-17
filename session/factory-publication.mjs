import { askFactory } from './factory-channel.mjs';
import { isLandingPull, requireLandingAuthority } from './factory-authority.mjs';
import { publishLanding } from './factory-mirror.mjs';
import { pullUrl, writeRecord } from './factory-records.mjs';
import { reportToPrincipal } from './factory-reports.mjs';

export function finishPublication(record) {
  requireLandingAuthority(record.repository);
  publishLanding(record.repository, record.release);
  return reportToPrincipal({ ...record, stage: 'published' },
    `PR factory merged ${pullUrl(record)} as ${record.mergeCommit}, signed landing commit ${record.release.commit} with ${record.release.fingerprint}, and published it to main. Receiver installation is not yet observed. The Mac continues waiting for an operator-signed tip.`);
}

export function signPublication(record, facts) {
  if (!isLandingPull(record)) return reportToPrincipal({ ...record, stage: 'merged', mergeCommit: facts.mergeCommit?.oid }, `PR factory merged ${pullUrl(record)} into ${facts.baseRefName} as ${facts.mergeCommit?.oid}, after a ${record.verdict} verdict on head ${record.head}.`);
  requireLandingAuthority(record.repository);
  const merged = facts.mergeCommit?.oid;
  if (!merged || facts.headRefOid !== record.head || facts.baseRefName !== 'main') {
    throw new Error('factory: the merged pull request does not match the checked release. Nothing was signed.');
  }
  const release = askFactory('landing', { repository: record.repository, number: record.number, head: record.head, merged, base: record.releaseBase });
  const signed = writeRecord({ ...record, stage: 'signed', mergeCommit: merged, release });
  return finishPublication(signed);
}
