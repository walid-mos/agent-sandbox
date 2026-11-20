import { isLandingPull, isRetiredSessionFactory, requireLandingAuthority } from './factory-authority.mjs';
import { probe, runLegacyChecks } from './factory-checks.mjs';
import { logScanFailure, scanStaleDrafts } from './factory-draft-reminders.mjs';
import { draftPulls, FACTORY_TOPIC, isReadyHead, pullFacts, readyPulls, watchedRepositories } from './factory-github.mjs';
import { branchTip, mergeBase, refreshMirror } from './factory-mirror.mjs';
import { logDirectory, readRecord, recordedHeads, withRecord } from './factory-records.mjs';
import { pullUrl } from './github-url.mjs';
import { finishPublication } from './factory-publication.mjs';
import { hasChecks } from './factory-repositories.mjs';
import { deliverWakes, queueFactoryWake, queueReport } from './factory-reports.mjs';
import { isPendingSquash } from './factory-squash-publication.mjs';

// GitHub computes mergeability in the background, so a pull request it has not computed yet waits for the next scan.
const isDecidable = pull => pull.mergeable === 'MERGEABLE' || pull.mergeable === 'CONFLICTING';
const CHECKS_MISSING = 'checks-missing';
const CHECKED = 'checked';
const HELD = 'held';

function isRetargetedReview(pull, record) {
  return record?.stage === CHECKED && record.base !== pull.base;
}

function isNew({ pull, previous }, isChecked) {
  if (!previous || previous.stage === HELD) return true;
  return isChecked && (previous.stage === CHECKS_MISSING || isRetargetedReview(pull, previous));
}

function isSameStage({ stage, generation } = {}, { stage: expectedStage, generation: expectedGeneration } = {}) {
  return stage === expectedStage && generation === expectedGeneration;
}

function newHeads(repository, isChecked) {
  return readyPulls(repository)
    .map(pull => ({ repository, number: pull.number, head: pull.headRefOid, base: pull.baseRefName, branch: pull.headRefName, mergeable: pull.mergeable }))
    .filter(isDecidable)
    .map(pull => ({ pull, previous: readRecord(pull) }))
    .filter(candidate => isNew(candidate, isChecked));
}

function holdRecord(previous) {
  if (!previous || previous.stage === HELD || previous.recoveryOf || previous.squashPublication) return;
  withRecord(previous, (record, save) => {
    if (isSameStage(record, previous)) save({ ...record, stage: HELD });
  });
}

function holdDrafts(repository) {
  for (const pull of draftPulls(repository)) {
    holdRecord(readRecord({ repository, number: pull.number, head: pull.headRefOid }));
  }
}

function holdUnwatched(repositories) {
  const watched = new Set(repositories);
  for (const record of recordedHeads()) {
    if (!watched.has(record.repository)) holdRecord(record);
  }
}

function missingChecksText(pull) {
  return `PR factory cannot check ${pullUrl(pull)} at head ${pull.head}: ${pull.repository} has the ${FACTORY_TOPIC} topic, and session/factory-repositories.json in agent-sandbox defines no checks for it. Nothing was checked, judged or merged. Once its checks are defined there, the next scan takes this head.`;
}

function failedCheckText(pull, failed) {
  return `PR factory stopped ${pullUrl(pull)} at head ${pull.head}: its ${failed.name} check failed. The log is ${failed.log}. The pull request stays open and unmerged until a new head passes.`;
}

function check(subject) {
  requireLandingAuthority(subject.repository);
  const base = mergeBase(subject.repository, subject.base, subject.head);
  if (isLandingPull(subject) && branchTip(subject.repository, subject.base) !== base) {
    return queueReport({ ...subject, stage: 'stale-base' }, `PR factory needs a fresh head containing the target tip for ${pullUrl(subject)}.`);
  }
  const checks = runLegacyChecks(subject, base, logDirectory(subject));
  const failed = checks.find(result => !result.isPassed);
  if (failed) return queueReport({ ...subject, stage: 'checks-failed', mergeBase: base, checks }, failedCheckText(subject, failed));
  return queueFactoryWake({ ...subject, stage: CHECKED, mergeBase: base, checks });
}

function reportMissingChecks({ mergeable, ...subject }) {
  return queueReport({ ...subject, stage: CHECKS_MISSING }, missingChecksText(subject));
}

function handle({ mergeable, ...subject }) {
  if (mergeable === 'CONFLICTING') return queueFactoryWake({ ...subject, stage: 'conflict' });
  return check(subject);
}

function isCurrentCandidate(pull) {
  const facts = pullFacts(pull);
  return isReadyHead(pull, facts) && facts.baseRefName === pull.base
    && facts.headRefName === pull.branch && facts.mergeable === pull.mergeable;
}

function recordCandidate({ pull, previous }, step) {
  return withRecord(pull, (record, save) => {
    if (!isSameStage(record, previous)) return undefined;
    const isRetargeted = isRetargetedReview(pull, record);
    if (isRetargeted && !isCurrentCandidate(pull)) return undefined;
    const { generation = 0, stage, pendingWakes } = record ?? {};
    const nextGeneration = stage === HELD || isRetargeted ? generation + 1 : generation;
    return save(step({ ...pull, generation: nextGeneration, pendingWakes }));
  });
}

function handleLogged(pull, step) {
  try {
    const record = step();
    if (!record) return;
    deliverWakes(record);
    process.stdout.write(`factory: ${pullUrl(pull)} at ${pull.head}: ${record.stage}\n`);
  } catch (error) {
    logScanFailure(`${pullUrl(pull)} at ${pull.head}`, error);
  }
}

function flushWakes() {
  for (const record of recordedHeads().filter(head => head.pendingWakes?.length)) handleLogged(record, () => record);
}

function scanReadyPulls(repositories) {
  holdUnwatched(repositories);
  const { checked = [], unchecked = [] } = Object.groupBy(repositories, repository => (hasChecks(repository) ? 'checked' : 'unchecked'));
  for (const repository of checked) holdDrafts(repository);
  flushWakes();
  for (const candidate of unchecked.flatMap(repository => newHeads(repository, false))) {
    handleLogged(candidate.pull, () => recordCandidate(candidate, reportMissingChecks));
  }
  const pending = checked.flatMap(repository => newHeads(repository, true));
  if (pending.length === 0) return;
  process.stdout.write(`${probe()}\n`);
  for (const repository of new Set(pending.map(({ pull }) => pull.repository))) refreshMirror(repository);
  for (const candidate of pending) handleLogged(candidate.pull, () => recordCandidate(candidate, handle));
}

export function scanLegacy() {
  if (isRetiredSessionFactory) return;
  const repositories = watchedRepositories();
  for (const record of recordedHeads().filter(isPendingSquash)) {
    if (repositories.includes(record.repository)) handleLogged(record, () => finishPublication(record));
  }
  scanReadyPulls(repositories);
  scanStaleDrafts(repositories);
}
