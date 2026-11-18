import { isLandingPull } from './factory-authority.mjs';
import { pullUrl } from './github-url.mjs';
import { reportToPrincipal } from './factory-reports.mjs';

export function finishPublication() {
  throw new Error('factory: a legacy signed record cannot authorize publication. Wait for the bound review transition.');
}

export function signPublication(record, facts) {
  if (isLandingPull(record)) return finishPublication();
  return reportToPrincipal({ ...record, stage: 'merged', mergeCommit: facts.mergeCommit?.oid },
    `PR factory merged ${pullUrl(record)} into ${facts.baseRefName} as ${facts.mergeCommit?.oid}, after a ${record.verdict} verdict on head ${record.head}.`);
}
