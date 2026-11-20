import { spawnSync } from 'node:child_process';
import { isLandingPull, landingRepository, requireFactoryRuntime, requireLandingAuthority } from './factory-authority.mjs';
import { accorPublicationPolicy } from './accor-publication-policy.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { pullUrl } from './github-url.mjs';
import { checkSteps } from './factory-repositories.mjs';
import { command } from './run.mjs';
import { owners, sandbox } from './sandbox.mjs';

export const FACTORY_TOPIC = 'factory';
const REPOSITORY_LIMIT = '1000';
const LIST_FIELDS = isDurableFactory ? 'number,isDraft' : 'number,headRefOid,headRefName,baseRefName,isDraft,mergeable';
const CALL_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 15_000;
// Durable discovery names one exact attempt, so it reads the head, base and ready transition GitHub holds now rather than trusting a listing.
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
const VIEW_FIELDS = 'state,title,body,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository,mergeCommit,mergeable';
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
    { env: { ...process.env, GH_REPO: owner }, ...(isDurableFactory && { timeout: LIST_TIMEOUT_MS }) });
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
    { env: { ...process.env, GH_REPO: repository }, ...(isDurableFactory && flags.includes('--paginate') && { timeout: LIST_TIMEOUT_MS }) }));
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

function requireTopic(repository) {
  const topicNames = JSON.parse(gh(['api', `repos/${repository}`, '--jq', '.topics']));
  if (!hasFactoryTopic(topicNames)) throw new Error(`factory: ${repository} no longer has the ${FACTORY_TOPIC} topic, so the factory leaves its pull requests alone.`);
}

export function isReadyHead(pull, facts) {
  return facts.state === 'OPEN' && !facts.isDraft && facts.headRefOid === pull.head;
}

function requireCurrentReview(pull, facts) {
  if (!isReadyHead(pull, facts)) {
    throw new Error(`factory: ${pullUrl(pull)} is ${facts.isDraft ? 'a draft' : facts.state} at ${facts.headRefOid}, and this step covers ${pull.head} only, while it is open and ready. The next scan takes a new head once the pull request is ready.`);
  }
  if (facts.baseRefName !== pull.base) {
    throw new Error(`factory: ${pullUrl(pull)} now targets ${facts.baseRefName}, and this step covers ${pull.base} only. Use a fresh Factory attempt for the new target.`);
  }
}

function requireFactoryAccess(pull) {
  requireFactoryRuntime();
  requireLandingAuthority(pull.repository);
  if (accorPublicationPolicy(sandbox)) throw new Error('factory: the Accor publication policy requires a separate human decision to merge.');
}

function requireRepositoryPolicy(pull) {
  requireModeReview(pull);
  checkSteps(pull.repository);
}

export function requireReviewPolicy(pull) {
  requireFactoryAccess(pull);
  requireTopic(pull.repository);
}

export function requireActionable(pull) {
  requireFactoryAccess(pull);
  const facts = pullFacts(pull);
  requireCurrentReview(pull, facts);
  requireRepositoryPolicy(pull);
  return facts;
}

const READY_TRANSITIONS = new Set(['ReadyForReviewEvent', 'ReopenedEvent']);

function hasReadyTransition(node) {
  return READY_TRANSITIONS.has(node?.__typename) && typeof node.id === 'string' && node.id.length > 0;
}

function readyEventId([node, ...extra]) {
  if (extra.length > 0 || !hasReadyTransition(node)) throw new Error('factory: GitHub did not confirm a ready review transition');
  return node.id;
}

function reviewTransition(timeline) {
  const nodes = timeline?.nodes;
  if (!Array.isArray(nodes)) throw new Error('factory: GitHub did not confirm a review timeline');
  if (nodes.length === 0) return '';
  return readyEventId(nodes);
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
  const response = queryPulls(subject.repository, REVIEW_FACTS_QUERY, '-F', `number=${subject.number}`);
  if (response.errors?.length) throw new Error('factory: GitHub returned incomplete review facts');
  const result = namedRepository(response.data?.repository, subject.repository);
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

// A squash recovery review covers a landed commit, so only a live review generation is checked against the pull request GitHub holds now.
function requireModeReview(pull) {
  if (isDurableFactory && !pull.recoveryOf) requireReviewSubject(pull);
  else requireTopic(pull.repository);
}

export function mergeReadback({ repository, number }) {
  const pull = JSON.parse(gh(['api', `repos/${repository}/pulls/${number}`]));
  return { repository: pull.base?.repo?.full_name, number: pull.number, head: pull.head?.sha,
    ref: `refs/heads/${pull.base?.ref}`, state: pull.merged === true && pull.state === 'closed' ? 'MERGED' : pull.merged === false && pull.state === 'open' ? 'open' : undefined,
    squash: pull.merge_commit_sha };
}

export function comment({ repository, number }, bodyFile) {
  gh(['pr', 'comment', String(number), '--repo', repository, '--body-file', bodyFile]);
}

export function commentAuthor({ repository }) {
  const author = Number(gh(['api', 'user', '--jq', '.id'], { env: { ...process.env, GH_REPO: repository } }));
  if (!Number.isSafeInteger(author) || author <= 0) throw new Error('factory: could not identify the GitHub verdict author.');
  return author;
}

export function hasComment({ repository, number }, author, body) {
  const pages = JSON.parse(gh(['api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']));
  if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) {
    throw new Error('factory: GitHub returned an invalid verdict comment listing.');
  }
  return pages.some(page => page.some(entry => entry?.user?.id === author
    && typeof entry.body === 'string' && entry.body.trimEnd() === body));
}

export function squashMerge(record) {
  const { repository, number, head } = record;
  if (repository.toLowerCase() === landingRepository.toLowerCase()) {
    requireLandingAuthority(repository);
    if (!isLandingPull(record) || record.stage !== 'squash-pending') throw new Error('factory: native squash requires a saved merge intent for the enrolled target.');
  }
  const merge = spawnSync('gh', ['pr', 'merge', String(number), '--repo', repository, '--squash', '--match-head-commit', head], { encoding: 'utf8' });
  return { isAccepted: merge.status === 0, output: `${merge.stdout ?? ''}${merge.stderr ?? ''}`.trim() };
}
