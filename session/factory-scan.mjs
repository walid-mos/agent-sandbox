import { probe, runChecks } from './factory-checks.mjs';
import { draftPulls, FACTORY_TOPIC, readyPulls, watchedRepositories } from './factory-github.mjs';
import { branchTip, mergeBase, refreshMirror } from './factory-mirror.mjs';
import { logDirectory, pullUrl, readRecord, recordedHeads, writeRecord } from './factory-records.mjs';
import { hasChecks } from './factory-repositories.mjs';
import { flushReports, handToFactory, reportToPrincipal } from './factory-reports.mjs';
import { isLandingPull, requireFactoryRuntime, requireLandingAuthority } from './factory-authority.mjs';
import { finishPublication } from './factory-publication.mjs';

// GitHub computes mergeability in the background, so a pull request it has not computed yet waits for the next scan.
const isDecidable = pull => pull.mergeable === 'MERGEABLE' || pull.mergeable === 'CONFLICTING';
const CHECKS_MISSING = 'checks-missing';
const HELD = 'held';

// A head reported for missing checks is taken again once its repository's checks are defined, and a head that went back to draft once it is ready again.
function isNew(pull, isChecked) {
  const record = readRecord(pull);
  return !record || record.stage === HELD || (isChecked && record.stage === CHECKS_MISSING);
}

// A wake ID is one per generation, so a head taken again after a hold wakes its judge again.
function nextGeneration(pull) {
  const record = readRecord(pull);
  return (record?.generation ?? 0) + (record?.stage === HELD ? 1 : 0);
}

function newHeads(repository, isChecked) {
  return readyPulls(repository)
    .map(pull => ({ repository, number: pull.number, head: pull.headRefOid, base: pull.baseRefName, branch: pull.headRefName, mergeable: pull.mergeable }))
    .filter(pull => isDecidable(pull) && isNew(pull, isChecked))
    .map(pull => ({ ...pull, generation: nextGeneration(pull) }));
}

function holdDrafts(repository) {
  for (const pull of draftPulls(repository)) {
    const record = readRecord({ repository, number: pull.number, head: pull.headRefOid });
    if (record && record.stage !== HELD) writeRecord({ ...record, stage: HELD });
  }
}

function holdUnwatched(repositories) {
  const watched = new Set(repositories);
  for (const record of recordedHeads()) {
    if (!watched.has(record.repository) && record.stage !== HELD) writeRecord({ ...record, stage: HELD });
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
  const releaseBase = isLandingPull(subject) ? branchTip(subject.repository, 'main') : undefined;
  if (releaseBase && releaseBase !== base) {
    return reportToPrincipal({ ...subject, stage: 'stale-base' }, `PR factory requires a new head of ${pullUrl(subject)} containing current main ${releaseBase} before checking a signed release.`);
  }
  const checks = runChecks(subject, base, logDirectory(subject));
  const failed = checks.find(result => !result.isPassed);
  if (failed) return reportToPrincipal({ ...subject, stage: 'checks-failed', mergeBase: base, checks }, failedCheckText(subject, failed));
  return handToFactory({ ...subject, stage: 'checked', mergeBase: base, releaseBase, checks });
}

function reportMissingChecks({ mergeable, ...subject }) {
  return reportToPrincipal({ ...subject, stage: CHECKS_MISSING }, missingChecksText(subject));
}

function handle({ mergeable, ...subject }) {
  if (mergeable === 'CONFLICTING') return handToFactory({ ...subject, stage: 'conflict' });
  return check(subject);
}

function handleLogged(pull, step) {
  try {
    const record = step(pull);
    process.stdout.write(`factory: ${pullUrl(pull)} at ${pull.head}: ${record.stage}\n`);
  } catch (error) {
    process.stderr.write(`factory: ${pullUrl(pull)} at ${pull.head}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function scan() {
  if (ownsSigningFactory && !isIsolatedFactory) {
    process.stdout.write('factory: this pot runs its factory outside the worker session, so this scan does nothing.\n');
    return;
  }
  flushReports();
  for (const record of recordedHeads().filter(record => record.stage === 'signed')) handleLogged(record, finishPublication);
  const repositories = watchedRepositories();
  holdUnwatched(repositories);
  const { checked = [], unchecked = [] } = Object.groupBy(repositories, repository => (hasChecks(repository) ? 'checked' : 'unchecked'));
  for (const pull of unchecked.flatMap(repository => newHeads(repository, false))) handleLogged(pull, reportMissingChecks);
  for (const repository of checked) holdDrafts(repository);
  const pending = checked.flatMap(repository => newHeads(repository, true));
  if (pending.length === 0) return;
  process.stdout.write(`${probe()}\n`);
  for (const repository of new Set(pending.map(pull => pull.repository))) refreshMirror(repository);
  for (const pull of pending) handleLogged(pull, handle);
}
