import { spawnSync } from 'node:child_process';
import { pullUrl } from './github-url.mjs';
import { checkSteps } from './factory-repositories.mjs';
import { command } from './run.mjs';
import { owners, sandbox } from './sandbox.mjs';
import { landingRepository, requireFactoryRuntime, requireLandingAuthority } from './factory-authority.mjs';
import { accorPublicationPolicy } from './accor-publication-policy.mjs';

export const FACTORY_TOPIC = 'factory';
const REPOSITORY_LIMIT = '1000';
const LIST_FIELDS = 'number,headRefOid,headRefName,baseRefName,isDraft,mergeable';
const VIEW_FIELDS = 'state,title,body,headRefOid,headRefName,baseRefName,baseRefOid,isDraft,isCrossRepository,mergeCommit';
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

const gh = (arguments_, options) => command('gh', arguments_, options);
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

export function openPulls(repository) {
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

function requireTopic(repository) {
  const topicNames = JSON.parse(gh(['api', `repos/${repository}`, '--jq', '.topics']));
  if (!hasFactoryTopic(topicNames)) throw new Error(`factory: ${repository} no longer has the ${FACTORY_TOPIC} topic, so the factory leaves its pull requests alone.`);
}

export function requireActionable(pull) {
  requireFactoryRuntime();
  requireLandingAuthority(pull.repository);
  if (accorPublicationPolicy(sandbox)) throw new Error('factory: the Accor publication policy requires a separate human decision to merge.');
  const facts = pullFacts(pull);
  if (facts.state !== 'OPEN' || facts.isDraft || facts.headRefOid !== pull.head) {
    throw new Error(`factory: ${pullUrl(pull)} is ${facts.isDraft ? 'a draft' : facts.state} at ${facts.headRefOid}, and this step covers ${pull.head} only, while it is open and ready. The next scan takes a new head once the pull request is ready.`);
  }
  requireTopic(pull.repository);
  checkSteps(pull.repository);
  return facts;
}

export function comment({ repository, number }, bodyFile) {
  gh(['pr', 'comment', String(number), '--repo', repository, '--body-file', bodyFile]);
}

// GitHub refuses the merge when the head moved since the verdict, or when the pull request went back to draft, so a merge never lands code the verdict did not cover.
export function squashMerge({ repository, number, head }) {
  if (repository === landingRepository) throw new Error('factory: the GitHub squash operation cannot bind the checked target and base. Use the signed publication path once its review record integration is ready.');
  const merge = spawnSync('gh', ['pr', 'merge', String(number), '--repo', repository, '--squash', '--match-head-commit', head], { encoding: 'utf8' });
  return `${merge.stdout ?? ''}${merge.stderr ?? ''}`.trim();
}
