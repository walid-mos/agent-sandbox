import { activeDraftBlock } from './factory-stale-draft.mjs';
import { FACTORY_REVIEW, FACTORY_STOP, FACTORY_STAGES, pullLink, REPOSITORY, utcDay } from './pr-board-contract.mjs';
const trim = (text, size) => `${text}`.slice(0, size);

function hasPendingQuestion(workers, dialogs) {
  return dialogs.some(dialog => dialog.kind === 'question' && !dialog.result && dialog.source.type === 'worker' && workers.some(worker =>
    worker.name === dialog.source.worker && worker.sessionFile && worker.sessionFile === dialog.source.session));
}

function reportedChecks(record) {
  if (record.stage === 'checks-missing') return 'missing';
  if (record.checks?.some(check => check.isPassed === false)) return 'failed';
  if (record.checks?.length && record.checks.every(check => check.isPassed === true)) return 'passed';
  return 'not-run';
}

function factoryFacts(pull, records) {
  const record = records.find(record => record.repository === pull.repository && record.number === pull.number && record.head === pull.head.sha);
  if (!FACTORY_STAGES.includes(record?.stage)) return undefined;
  return { stage: record.stage, checks: reportedChecks(record) };
}

function localState(pull, workers, { dialogs, isStopped }, factory) {
  if (hasPendingQuestion(workers, dialogs)) return { state: 'waiting', evidence: { kind: 'human-dialog' } };
  if (workers.some(isStopped)) return { state: 'blocked', evidence: { kind: 'worker-hold' } };
  if (FACTORY_STOP.includes(factory?.stage)) return { state: 'blocked', evidence: { kind: 'factory-stop' } };
  if (FACTORY_REVIEW.includes(factory?.stage)) return { state: 'factory-review', evidence: { kind: 'factory-review' } };
  return { state: pull.draft ? 'draft' : 'ready' };
}

function workerOwnsPull(worker, pull) {
  if (worker.repository !== pull.repository) return false;
  if (worker.pullRequest) return worker.pullRequest === pullLink(pull);
  return pull.head.repo?.full_name === pull.repository && worker.branch === pull.head.ref;
}

function pullRow(pull, facts, now) {
  const workers = facts.workers.filter(worker => workerOwnsPull(worker, pull));
  if (workers.length > 8) throw new Error('pr-board: too many workers for a complete pull request row.');
  const factory = factoryFacts(pull, facts.factory);
  const common = { repository: pull.repository, number: pull.number, title: trim(pull.title, 256),
    workers: workers.map(worker => trim(worker.title || worker.name, 96)), createdAt: Date.parse(pull.created_at), ...(factory && { factory }) };
  if (pull.merged_at) return { ...common, githubState: 'merged', state: 'merged-today', mergedAt: Date.parse(pull.merged_at) };
  const blockedUntil = pull.draft && activeDraftBlock(pull.body ?? '', now);
  return { ...common, githubState: pull.draft ? 'draft' : 'ready', ...localState(pull, workers, facts, factory), ...(blockedUntil && { blockedUntil }) };
}

export function collectPulls(source, now) {
  const workers = source.workers();
  const factories = source.factory();
  const dialogs = source.dialogs();
  const owned = repository => REPOSITORY.test(repository ?? '') && source.owners.some(owner => owner.toLowerCase() === repository.split('/')[0].toLowerCase());
  const repositories = [...new Set([...source.watched(), ...workers.map(worker => worker.repository)])].filter(owned).sort();
  const facts = { workers, factory: factories, dialogs, isStopped: source.isStopped };
  return repositories.flatMap(repository => source.pulls(repository, now)
    .filter(pull => !pull.merged_at || utcDay(Date.parse(pull.merged_at)) === utcDay(now))
    .map(pull => pullRow({ ...pull, repository }, facts, now)));
}
