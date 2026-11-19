import { setTimeout as delay } from 'node:timers/promises';
import { draftCandidates, draftFacts, readyPulls, reviewSubject, watchedRepositories } from './factory-github.mjs';
import { pullUrl } from './factory-records.mjs';
import { reportStaleDraft } from './factory-reports.mjs';
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
  return readyPulls(repository).map(({ number }) => ({ repository, number }));
}

export async function discoverReady(jobs, repositories, read = reviewSubject, wait = delay) {
  const discover = subject => inspectPull(subject, jobs, read);
  const unknown = repositories.flatMap(readySubjects).map(discover).filter(Boolean).slice(0, MAX_MERGEABILITY_RETRIES);
  if (unknown.length === 0) return;
  await wait(MERGEABILITY_RETRY_MS);
  unknown.forEach(discover);
}

function logScanFailure(subject, error) {
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

export function scan() {
  return withJobs(async jobs => {
    const repositories = watchedRepositories();
    const now = Date.now();
    let workerRecords;
    const readWorkers = () => (workerRecords ??= workers());
    for (const repository of repositories) scanStaleDrafts(repository, now, readWorkers);
    await discoverReady(jobs, repositories);
  });
}
