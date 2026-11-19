import { isIsolatedFactory, isLandingPull, requireLandingAuthority } from './factory-authority.mjs';
import { effectiveCheckRevision } from './factory-checks.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { draftCandidates, draftFacts, pullFacts, readyPulls, reviewSubject, watchedRepositories } from './factory-github.mjs';
import { finishPublication } from './factory-publication.mjs';
import { pullUrl, readRecord, recordedHeads, withRecord } from './factory-records.mjs';
import { hasChecks } from './factory-repositories.mjs';
import { isPendingSquash } from './factory-squash-publication.mjs';
import { deliverWakes, reportStaleDraft } from './factory-reports.mjs';
import { isOldDraft, staleDraftWakeId } from './factory-stale-draft.mjs';
import { withJobs } from './factory-state.mjs';
import { workers } from './workers.mjs';

const MERGEABILITY_RETRY_MS = 5_000;
const MAX_MERGEABILITY_RETRIES = 10;

const DECIDABLE = new Set(['MERGEABLE', 'CONFLICTING']);

function inspectPull(subject, jobs, read) {
  try {
    const pull = read(subject);
    if (pull) return recordObservation(pull, jobs);
  } catch (error) {
    logScanFailure(pullUrl(subject), error);
  }
}

function recordObservation(pull, jobs) {
  if (pull.mergeable === 'UNKNOWN') return pull;
  if (DECIDABLE.has(pull.mergeable)) jobs.observe(pull);
}

function readySubjects(repository) {
  try {
    return readyPulls(repository).map(({ number }) => ({ repository, number }));
  } catch (error) {
    logScanFailure(`${repository} ready discovery`, error);
    return [];
  }
}

export async function discoverReady(jobs, repositories, read = reviewSubject, wait = delay) {
  const discover = subject => inspectPull(subject, jobs, read);
  const unknown = repositories.flatMap(repository => readySubjects(repository).map(discover)).filter(Boolean).slice(0, MAX_MERGEABILITY_RETRIES);
  if (unknown.length === 0) return;
  await wait(MERGEABILITY_RETRY_MS);
  unknown.forEach(discover);
}

export function logScanFailure(subject, error) {
  process.stderr.write(`factory: ${subject}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function ownsDraft(worker, pull) {
  return worker.repository?.toLowerCase() === pull.repository.toLowerCase() && worker.branch === pull.headRefName
    && (worker.pullRequest ?? pullUrl(pull)).toLowerCase() === pullUrl(pull).toLowerCase();
}

function draftOwner(pull, readWorkers) {
  if (pull.isCrossRepository) return undefined;
  return readWorkers().find(worker => worker.owner && ownsDraft(worker, pull))?.owner;
}

function wakeStaleDraft(subject, now, readWorkers) {
  const pull = draftFacts(subject.repository, subject.number);
  if (pull.state !== 'OPEN') return;
  const id = staleDraftWakeId(pull, now);
  if (id) reportStaleDraft(pull, id, draftOwner(pull, readWorkers));
}

function scanRepositoryDrafts(repository, now, readWorkers, holdReview) {
  let candidates;
  try {
    candidates = draftCandidates(repository).filter(pull => pull.isDraft === true);
  } catch (error) {
    return logScanFailure(`${repository} draft discovery`, error);
  }
  for (const candidate of candidates) {
    const subject = { repository, number: candidate.number };
    if (holdReview) processDraft(subject, 'hold', () => holdReview(subject));
    if (isOldDraft(candidate, now)) processDraft(subject, 'reminder', () => wakeStaleDraft(subject, now, readWorkers));
  }
}

function processDraft(subject, operation, run) {
  try {
    run();
  } catch (error) {
    logScanFailure(`${pullUrl(subject)} draft ${operation}`, error);
  }
}

export function scanStaleDrafts(repositories, holdReview) {
  const now = Date.now();
  let workerRecords;
  const readWorkers = () => (workerRecords ??= workers());
  for (const repository of repositories) scanRepositoryDrafts(repository, now, readWorkers, holdReview);
}

function observeInputs(pull, revisions) {
  if (pull && isLandingPull(pull)) requireLandingAuthority(pull.repository);
  if (pull?.mergeable !== 'MERGEABLE' || !hasChecks(pull.repository)) return pull;
  if (!revisions.has(pull.repository)) revisions.set(pull.repository, effectiveCheckRevision(pull.repository));
  return { ...pull, inputRevision: revisions.get(pull.repository) };
}

function holdDraftReview(jobs, { repository, number }) {
  const generation = jobs.current({ repository: repository.toLowerCase(), number });
  const job = generation === undefined ? undefined : jobs.get(generation);
  if (!job) return;
  const record = readRecord({ ...job.subject, generation });
  if (record?.generation !== generation || record.stage === 'held' || record.squashPublication) return;
  withRecord(record, (current, save) => {
    if (current?.generation !== generation || current.stage === 'held' || current.squashPublication || jobs.current(current) !== generation) return;
    const facts = pullFacts(current);
    if (facts.state === 'OPEN' && facts.isDraft === true && facts.headRefOid === current.head && jobs.current(current) === generation) {
      return save({ ...current, stage: 'held' });
    }
    return current;
  });
}

function recoverPublications(repositories) {
  const watched = new Set(repositories.map(repository => repository.toLowerCase()));
  for (const record of recordedHeads()) {
    const needsReadback = isIsolatedFactory && isPendingSquash(record);
    if ((!needsReadback && !record.pendingWakes?.length) || !watched.has(record.repository.toLowerCase())) continue;
    try {
      deliverWakes((needsReadback ? finishPublication(record) : undefined) ?? record);
    } catch (error) {
      logScanFailure(pullUrl(record), error);
    }
  }
}

export function scanReady(jobs, repositories = watchedRepositories()) {
  const revisions = new Map();
  return discoverReady(jobs, repositories, subject => observeInputs(reviewSubject(subject), revisions));
}

export function scanMaintenance(jobs, repositories = watchedRepositories()) {
  recoverPublications(repositories);
  scanStaleDrafts(repositories, subject => holdDraftReview(jobs, subject));
}

export function scan({ routine }) {
  return withJobs(async jobs => {
    const repositories = watchedRepositories();
    await scanReady(jobs, repositories);
    if (routine) scanMaintenance(jobs, repositories);
  });
}
