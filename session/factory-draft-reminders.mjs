import { draftCandidates, draftFacts } from './factory-github.mjs';
import { reportStaleDraft } from './factory-reports.mjs';
import { isOldDraft, staleDraftWakeId } from './factory-stale-draft.mjs';
import { pullUrl } from './github-url.mjs';
import { workers } from './workers.mjs';

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

function processDraft(subject, operation, run) {
  try {
    run();
  } catch (error) {
    logScanFailure(`${pullUrl(subject)} draft ${operation}`, error);
  }
}

export function scanRepositoryDrafts(repository, now, readWorkers, holdReview) {
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

export function scanStaleDrafts(repositories, holdReview) {
  const now = Date.now();
  let workerRecords;
  const readWorkers = () => (workerRecords ??= workers());
  for (const repository of repositories) scanRepositoryDrafts(repository, now, readWorkers, holdReview);
}
