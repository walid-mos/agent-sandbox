import { digest, pullLink, REPOSITORY, utcDay } from './pr-board-contract.mjs';

const STOPS = ['held', 'checks-missing', 'checks-failed', 'failed', 'refused', 'escalated'];
const REVIEWS = ['checked', 'conflict', 'judged'];
const trim = (text, size) => `${text}`.slice(0, size);

function pendingQuestion(workers, dialogs) {
  return dialogs.find(dialog => !dialog.result && dialog.source.type === 'worker' && workers.some(worker =>
    worker.name === dialog.source.worker && worker.sessionId === dialog.source.session));
}

function localState(pull, workers, { dialogs, factory, isStopped }) {
  const question = pendingQuestion(workers, dialogs);
  if (question) return { state: 'waiting', evidence: { kind: 'human-dialog', id: question.id } };
  const stopped = workers.find(isStopped);
  if (stopped) return { state: 'blocked', evidence: { kind: 'worker-hold', id: trim(stopped.name, 128) } };
  const record = factory.find(record => record.repository === pull.repository && record.number === pull.number && record.head === pull.head.sha);
  if (STOPS.includes(record?.stage)) return { state: 'blocked', evidence: { kind: 'factory-stop', id: `${record.head}:${record.stage}` } };
  if (REVIEWS.includes(record?.stage)) return { state: 'factory-review', evidence: { kind: 'factory-review', id: record.head } };
  return { state: pull.draft ? 'draft' : 'ready' };
}

function pullRow(pull, facts) {
  const workers = facts.workers.filter(worker => worker.repository === pull.repository &&
    (worker.pullRequest === pullLink(pull) || worker.branch === pull.head.ref));
  const common = { repository: pull.repository, number: pull.number, title: trim(pull.title, 256),
    workers: workers.slice(0, 8).map(worker => trim(worker.title || worker.name, 96)), createdAt: Date.parse(pull.created_at) };
  if (workers.length > 8) throw new Error('pr-board: too many workers for a complete pull request row.');
  if (pull.merged_at) return { ...common, githubState: 'merged', state: 'merged-today', mergedAt: Date.parse(pull.merged_at) };
  return { ...common, githubState: pull.draft ? 'draft' : 'ready', ...localState(pull, workers, facts) };
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
    .map(pull => pullRow({ ...pull, repository }, facts)));
}
