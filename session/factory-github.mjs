import { spawnSync } from 'node:child_process';
import { accorPublicationPolicy } from './accor-publication-policy.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { pullUrl } from './factory-records.mjs';
import { checkSteps } from './factory-repositories.mjs';
import { command } from './run.mjs';
import { owners, sandbox } from './sandbox.mjs';

export const FACTORY_TOPIC = 'factory';
const REPOSITORY_LIMIT = '1000';
const LIST_FIELDS = isDurableFactory ? 'number,isDraft' : 'number,headRefOid,headRefName,baseRefName,isDraft,mergeable';
const CALL_TIMEOUT_MS = 5_000;
const REVIEW_FACTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner isArchived
    pullRequest(number: $number) {
      number state isDraft headRefOid headRefName baseRefOid baseRefName mergeable
      timelineItems(last: 1, itemTypes: [CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT, CLOSED_EVENT, REOPENED_EVENT]) {
        nodes { __typename ... on ConvertToDraftEvent { id } ... on ReadyForReviewEvent { id } ... on ReopenedEvent { id } }
      }
    }
  }
}`;
const VIEW_FIELDS = 'state,title,body,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository,mergeCommit';
const DRAFT_LIST_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $endCursor, states: OPEN) {
      nodes { number isDraft createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const DRAFT_FACTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state isDraft isCrossRepository createdAt lastEditedAt title body headRefName headRefOid
    }
  }
}`;

const gh = (arguments_, options) => command('gh', arguments_, isDurableFactory
  ? { timeout: CALL_TIMEOUT_MS, killSignal: 'SIGKILL', ...options } : options);
const hasFactoryTopic = topicNames => topicNames.includes(FACTORY_TOPIC);

// A listing names no repository, so GH_REPO tells the gh wrapper which owner's token to use.
function topicRepositories(owner) {
  const listing = gh(['repo', 'list', owner, '--no-archived', '--limit', REPOSITORY_LIMIT, '--json', 'nameWithOwner,repositoryTopics'],
    { env: { ...process.env, GH_REPO: owner } });
  const repositories = JSON.parse(listing);
  if (repositories.length >= Number(REPOSITORY_LIMIT)) {
    throw new Error(`factory: ${owner} reached the ${REPOSITORY_LIMIT}-repository discovery limit. The listing may be incomplete, so no recorded head can be held. Increase the limit or use complete pagination before scanning again.`);
  }
  return repositories.filter(repository => hasFactoryTopic((repository.repositoryTopics ?? []).map(topic => topic.name)))
    .map(repository => repository.nameWithOwner);
}

export const watchedRepositories = () => accorPublicationPolicy(sandbox) ? [] : owners.flatMap(topicRepositories);

function openPulls(repository) {
  return JSON.parse(gh(['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', LIST_FIELDS]));
}

export const readyPulls = repository => openPulls(repository).filter(pull => !pull.isDraft);
export const draftPulls = repository => openPulls(repository).filter(pull => pull.isDraft);

function queryPulls(repository, query, ...flags) {
  const [owner, name] = repository.split('/');
  return JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...flags],
    { env: { ...process.env, GH_REPO: repository } }));
}

export function draftCandidates(repository) {
  return queryPulls(repository, DRAFT_LIST_QUERY, '--paginate', '--slurp')
    .flatMap(page => page.data.repository.pullRequests.nodes);
}

export function draftFacts(repository, number) {
  const result = queryPulls(repository, DRAFT_FACTS_QUERY, '-F', `number=${number}`);
  return { ...result.data.repository.pullRequest, repository };
}

export function pullFacts({ repository, number }) {
  return JSON.parse(gh(['pr', 'view', String(number), '--repo', repository, '--json', VIEW_FIELDS]));
}

const READY_TRANSITIONS = new Set(['ReadyForReviewEvent', 'ReopenedEvent']);

function hasReadyTransition(node) {
  return READY_TRANSITIONS.has(node?.__typename) && typeof node.id === 'string' && node.id.length > 0;
}

function reviewTransition(timeline) {
  const nodes = timeline?.nodes;
  if (!Array.isArray(nodes)) throw new Error('factory: GitHub did not confirm a review timeline');
  if (nodes.length === 0) return '';
  return readyEventId(nodes);
}

function readyEventId([node, ...extra]) {
  if (extra.length > 0 || !hasReadyTransition(node)) throw new Error('factory: GitHub did not confirm a ready review transition');
  return node.id;
}

function confirmedRepository(subject) {
  const response = queryPulls(subject.repository, REVIEW_FACTS_QUERY, '-F', `number=${subject.number}`);
  if (response.errors?.length) throw new Error('factory: GitHub returned incomplete review facts');
  return namedRepository(response.data?.repository, subject.repository);
}

function namedRepository(result, repository) {
  if (result?.nameWithOwner?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('factory: GitHub did not confirm repository identity');
  }
  return result;
}

function exactRevision(facts, number) {
  const { headRefOid: head, baseRefOid: baseTip, baseRefName: base } = facts;
  if (![head, baseTip].every(sha => /^[0-9a-f]{40}$/.test(sha)) || typeof base !== 'string' || facts.number !== number) {
    throw new Error('factory: GitHub did not confirm the exact head and base');
  }
  return { head, base, baseTip };
}

function isReady(facts) {
  return facts?.state === 'OPEN' && facts.isDraft === false;
}

export function reviewSubject(subject) {
  const result = confirmedRepository(subject);
  const facts = result.pullRequest;
  if (result.isArchived !== false || !isReady(facts)) return undefined;
  return { repository: result.nameWithOwner.toLowerCase(), number: facts.number, ...exactRevision(facts, subject.number),
    transition: reviewTransition(facts.timelineItems), mergeable: facts.mergeable };
}

export function isCurrentReview(subject) {
  if (accorPublicationPolicy(sandbox)) return false;
  const current = reviewSubject(subject);
  return Boolean(current && ['head', 'base', 'baseTip', 'transition', 'mergeable'].every(key => current[key] === subject[key])
    && hasFactoryTopic(JSON.parse(gh(['api', `repos/${subject.repository}`, '--jq', '.topics']))));
}

export function requireReviewSubject(subject) {
  if (!isCurrentReview(subject)) throw new Error(`factory: ${pullUrl(subject)} no longer matches this review generation`);
}

function requireWatchedTopic(repository) {
  const topics = JSON.parse(gh(['api', `repos/${repository}`, '--jq', '.topics']));
  if (!hasFactoryTopic(topics)) throw new Error(`factory: ${repository} no longer has the ${FACTORY_TOPIC} topic, so the factory leaves its pull requests alone.`);
}

export function requireActionable(pull) {
  if (accorPublicationPolicy(sandbox)) throw new Error('factory: the Accor publication policy requires a separate human decision to merge.');
  const facts = pullFacts(pull);
  if (!isReady(facts) || facts.headRefOid !== pull.head) {
    throw new Error(`factory: ${pullUrl(pull)} no longer has open, ready head ${pull.head}. Wait for its next review wake.`);
  }
  requireModeReview(pull);
  checkSteps(pull.repository);
  return facts;
}

function requireModeReview(pull) {
  if (isDurableFactory) requireReviewSubject(pull);
  else requireWatchedTopic(pull.repository);
}

export function comment({ repository, number }, bodyFile) {
  gh(['pr', 'comment', String(number), '--repo', repository, '--body-file', bodyFile]);
}

// GitHub refuses the merge when the head moved since the verdict, or when the pull request went back to draft, so a merge never lands code the verdict did not cover.
export function squashMerge({ repository, number, head }) {
  const merge = spawnSync('gh', ['pr', 'merge', String(number), '--repo', repository, '--squash', '--match-head-commit', head], { encoding: 'utf8' });
  return { isAccepted: merge.status === 0, output: `${merge.stdout ?? ''}${merge.stderr ?? ''}`.trim() };
}
