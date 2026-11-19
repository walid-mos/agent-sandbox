import { probe, runChecks } from './factory-checks.mjs';
import { draftCandidates, draftFacts, draftPulls, FACTORY_TOPIC, readyPulls, watchedRepositories } from './factory-github.mjs';
import { mergeBase, refreshMirror } from './factory-mirror.mjs';
import { logDirectory, pullUrl, readRecord, recordedHeads, withRecord } from './factory-records.mjs';
import { hasChecks } from './factory-repositories.mjs';
import { deliverWakes, queueFactoryWake, queueReport, reportStaleDraft } from './factory-reports.mjs';
import { isOldDraft, staleDraftWakeId } from './factory-stale-draft.mjs';
import { workers } from './workers.mjs';

// GitHub computes mergeability in the background, so a pull request it has not computed yet waits for the next scan.
const isDecidable = pull => pull.mergeable === 'MERGEABLE' || pull.mergeable === 'CONFLICTING';
const CHECKS_MISSING = 'checks-missing';
const HELD = 'held';

// A head reported for missing checks is taken again once its repository's checks are defined, and a head that went back to draft once it is ready again.
function isNew(record, isChecked) {
  return !record || record.stage === HELD || (isChecked && record.stage === CHECKS_MISSING);
}

function isSameStage({ stage, generation } = {}, { stage: expectedStage, generation: expectedGeneration } = {}) {
  return stage === expectedStage && generation === expectedGeneration;
}

function newHeads(repository, isChecked) {
  return readyPulls(repository)
    .map(pull => ({ repository, number: pull.number, head: pull.headRefOid, base: pull.baseRefName, branch: pull.headRefName, mergeable: pull.mergeable }))
    .filter(isDecidable)
    .map(pull => ({ pull, previous: readRecord(pull) }))
    .filter(({ previous }) => isNew(previous, isChecked));
}

function holdRecord(previous) {
  if (!previous || previous.stage === HELD) return;
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
  const base = mergeBase(subject.repository, subject.base, subject.head);
  const checks = runChecks(subject, base, logDirectory(subject));
  const failed = checks.find(result => !result.isPassed);
  if (failed) return queueReport({ ...subject, stage: 'checks-failed', mergeBase: base, checks }, failedCheckText(subject, failed));
  return queueFactoryWake({ ...subject, stage: 'checked', mergeBase: base, checks });
}

function reportMissingChecks({ mergeable, ...subject }) {
  return queueReport({ ...subject, stage: CHECKS_MISSING }, missingChecksText(subject));
}

function handle({ mergeable, ...subject }) {
  if (mergeable === 'CONFLICTING') return queueFactoryWake({ ...subject, stage: 'conflict' });
  return check(subject);
}

function recordCandidate({ pull, previous }, step) {
  return withRecord(pull, (record, save) => {
    if (!isSameStage(record, previous)) return undefined;
    const { generation = 0, stage, pendingWakes } = record ?? {};
    return save(step({ ...pull, generation: stage === HELD ? generation + 1 : generation, pendingWakes }));
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

function logScanFailure(subject, error) {
  process.stderr.write(`factory: ${subject}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function draftOwner(pull, readWorkers) {
  if (pull.isCrossRepository) return undefined;
  return readWorkers().find(worker => worker.owner && worker.repository?.toLowerCase() === pull.repository.toLowerCase()
    && worker.branch === pull.headRefName && (!worker.pullRequest || worker.pullRequest.toLowerCase() === pullUrl(pull).toLowerCase()))?.owner;
}

function wakeStaleDraft(subject, now, readWorkers) {
  const pull = draftFacts(subject.repository, subject.number);
  if (pull.state !== 'OPEN') return;
  const id = staleDraftWakeId(pull, now);
  if (id) reportStaleDraft(pull, id, draftOwner(pull, readWorkers));
}

function scanStaleDrafts(repository, now, readWorkers) {
  let candidates;
  try {
    candidates = draftCandidates(repository).filter(pull => isOldDraft(pull, now));
  } catch (error) {
    return logScanFailure(`${repository} draft discovery`, error);
  }
  for (const { number } of candidates) {
    const subject = { repository, number };
    try {
      wakeStaleDraft(subject, now, readWorkers);
    } catch (error) {
      logScanFailure(`${pullUrl(subject)} draft reminder`, error);
    }
  }
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

export function scan() {
  const repositories = watchedRepositories();
  scanReadyPulls(repositories);
  const now = Date.now();
  let workerRecords;
  const readWorkers = () => (workerRecords ??= workers());
  for (const repository of repositories) scanStaleDrafts(repository, now, readWorkers);
}
