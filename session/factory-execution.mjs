import { runChecks } from './factory-checks.mjs';
import { isCurrentReview } from './factory-github.mjs';
import { mergeBase, refreshMirror } from './factory-mirror.mjs';
import { logDirectory, pullUrl } from './factory-records.mjs';
import { hasChecks } from './factory-repositories.mjs';
import { handToFactory, reportToPrincipal } from './factory-reports.mjs';
import { recoverJob, runJob, tryFactoryLock } from './factory-runner.mjs';
import { JOB_DIRECTORY, withJobs } from './factory-state.mjs';

function check(record, progress, jobs) {
  if (!isCurrentReview(record)) return { stage: 'superseded' };
  if (!hasChecks(record.repository)) return { stage: 'checks-missing' };
  if (record.mergeable === 'CONFLICTING') return { stage: 'conflict' };
  return checkRevision(record, progress, jobs);
}

function checkRevision(record, progress, jobs) {
  progress('preparing', {});
  refreshMirror(record.repository);
  const base = mergeBase(record.repository, record.baseTip, record.head);
  const checks = runChecks(record, base, logDirectory(record), progress, jobs);
  return { stage: checks.every(result => result.isPassed) ? 'checked' : 'checks-failed', mergeBase: base, checks };
}

export function executeJob([identifier]) {
  const id = jobId(identifier);
  return withJobs(jobs => runJob(jobs, JOB_DIRECTORY, id, (subject, progress) => check({ ...subject, generation: id }, progress, jobs)));
}

function jobId(identifier) {
  const id = Number(identifier);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('factory: expected a positive execution ID');
  return id;
}

export function recoverExecution([identifier]) {
  return withJobs(jobs => recoverJob(jobs, JOB_DIRECTORY, jobId(identifier)));
}

function publish(jobs, { id, subject, result, status }) {
  const record = { ...subject, ...result, generation: id };
  if (status === 'uncertain') {
    reportToPrincipal({ ...record, stage: 'uncertain' }, `PR factory cannot confirm execution or cleanup for ${pullUrl(record)} in run ${id}. Its runner is fenced. Inspect the recorded run and Docker state before clearing the fence.`);
    return;
  }
  if (status === 'interrupted') {
    reportToPrincipal({ ...record, stage: status }, `PR factory stopped run ${id} for ${pullUrl(record)} after interruption. ${result.reason}.`);
    return;
  }
  if (shouldPublish(jobs, record)) publishResult(record);
}

function shouldPublish(jobs, record) {
  return record.stage !== 'superseded' && jobs.current(record) === record.generation && isCurrentReview(record);
}

const FACTORY_STAGES = new Set(['checked', 'conflict']);

function publishResult(record) {
  if (FACTORY_STAGES.has(record.stage)) {
    handToFactory(record);
    return;
  }
  if (record.stage === 'checks-missing') {
    reportToPrincipal(record, `PR factory has no check definition for ${record.repository}. ${pullUrl(record)} stays open.`);
    return;
  }
  const failed = record.checks.find(result => !result.isPassed);
  reportToPrincipal(record, `PR factory stopped ${pullUrl(record)} at ${record.head}. ${failed.name}: ${failed.outcome}. Log: ${failed.log}`);
}

export function publishJob([identifier]) {
  return withJobs(jobs => {
    const id = jobId(identifier);
    const job = jobs.get(id);
    if (!job || !['complete', 'uncertain', 'interrupted'].includes(job.status)) return;
    const unlock = tryFactoryLock(JOB_DIRECTORY, `report-${id}`);
    if (!unlock) return;
    try {
      publish(jobs, job);
      jobs.markReported(id);
    } finally {
      unlock();
    }
  });
}
