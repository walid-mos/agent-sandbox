import { isIsolatedFactory, isLandingPull, requireLandingAuthority } from './factory-authority.mjs';
import { effectiveCheckRevision } from './factory-checks.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { logScanFailure, scanStaleDrafts } from './factory-draft-reminders.mjs';
import { readyPulls, reviewSubject, watchedRepositories } from './factory-github.mjs';
import { finishPublication } from './factory-publication.mjs';
import { pullUrl } from './github-url.mjs';
import { recordedHeads } from './factory-records.mjs';
import { hasChecks } from './factory-repositories.mjs';
import { isPendingSquash } from './factory-squash-publication.mjs';
import { deliverWakes } from './factory-reports.mjs';
import { withJobs } from './factory-state.mjs';

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

function observeInputs(pull, revisions) {
  if (pull && isLandingPull(pull)) requireLandingAuthority(pull.repository);
  if (pull?.mergeable !== 'MERGEABLE' || !hasChecks(pull.repository)) return pull;
  if (!revisions.has(pull.repository)) revisions.set(pull.repository, effectiveCheckRevision(pull.repository));
  return { ...pull, inputRevision: revisions.get(pull.repository) };
}

function recoverPublications(repositories) {
  const watched = new Set(repositories.map(repository => repository.toLowerCase()));
  for (const record of recordedHeads()) {
    if ((!isPendingSquash(record) && !record.pendingWakes?.length) || !watched.has(record.repository.toLowerCase())) continue;
    try {
      deliverWakes(finishPublication(record) ?? record);
    } catch (error) {
      logScanFailure(pullUrl(record), error);
    }
  }
}

export function scan({ routine }) {
  return withJobs(async jobs => {
    const repositories = watchedRepositories();
    const revisions = new Map();
    await discoverReady(jobs, repositories, subject => observeInputs(reviewSubject(subject), revisions));
    if (!routine) return;
    if (isIsolatedFactory) recoverPublications(repositories);
    scanStaleDrafts(repositories);
  });
}
