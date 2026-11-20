import { readFileSync } from 'node:fs';
import { main, runOperation } from './main.mjs';

export const OPERATIONS = ['fork', 'issue', 'push', 'pull-request'];
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refusal = message => new Error(`contributions: ${message} Fix sandbox.json and run bin/vm-config.`);

export const sameName = (first, second) => typeof first === 'string' && typeof second === 'string' && first.toLowerCase() === second.toLowerCase();
export const ownerOf = repository => repository.split('/')[0];
export const nameOf = repository => repository.split('/')[1];

export function isRepositoryName(value) {
  return typeof value === 'string' && REPOSITORY.test(value) && !value.endsWith('.git') && nameOf(value) !== '..';
}

function checkGrantShape(upstream, grant) {
  if (!isRepositoryName(upstream)) throw refusal(`${JSON.stringify(upstream)} is not one canonical OWNER/REPOSITORY key.`);
  if (!isObject(grant) || Object.keys(grant).sort().join() !== 'fork,operations') throw refusal(`${upstream} holds only fork and operations.`);
  if (!isRepositoryName(grant.fork) || sameName(grant.fork, upstream)) throw refusal(`${upstream} needs a fork that is another canonical OWNER/REPOSITORY.`);
}

const isOperationList = operations => Array.isArray(operations) && operations.length > 0
  && new Set(operations).size === operations.length && operations.every(name => OPERATIONS.includes(name));

const ownerEntry = (owners, owner) => Object.keys(owners).find(listed => sameName(listed, owner));

function credentialFor(upstream, fork, owners) {
  const credentialOwner = ownerEntry(owners, ownerOf(fork));
  if (!credentialOwner) throw refusal(`the fork owner ${ownerOf(fork)} of ${upstream} is not in owners.`);
  if (ownerEntry(owners, ownerOf(upstream))) throw refusal(`${upstream} belongs to an owner in owners. Use the ordinary route.`);
  return owners[credentialOwner];
}

function grantFrom(upstream, grant, owners) {
  checkGrantShape(upstream, grant);
  const { fork, operations } = grant;
  if (!isOperationList(operations)) throw refusal(`${upstream} operations are a nonempty list of distinct names from ${OPERATIONS.join(', ')}.`);
  return { upstream, fork, operations, credential: credentialFor(upstream, fork, owners) };
}

export function contributionPolicy(sandbox) {
  const grants = sandbox.contributions ?? {};
  if (!isObject(grants)) throw refusal('contributions must be an object.');
  const owners = isObject(sandbox.owners) ? sandbox.owners : {};
  const policy = Object.entries(grants).map(([upstream, grant]) => grantFrom(upstream, grant, owners));
  const distinct = (key, label) => {
    if (new Set(policy.map(grant => grant[key].toLowerCase())).size !== policy.length) throw refusal(`each ${label} appears once.`);
  };
  distinct('upstream', 'upstream');
  distinct('fork', 'fork');
  return policy;
}

export function grantFor(policy, upstream) {
  const grant = policy.find(entry => sameName(entry.upstream, upstream));
  if (!grant) throw new Error(`contribute: ${upstream} is not in this pot's contributions policy. Nothing was sent to GitHub.`);
  return grant;
}

export function requireOperation(grant, operation) {
  if (!grant.operations.includes(operation)) throw new Error(`contribute: the policy for ${grant.upstream} does not permit ${operation}. Nothing was sent to GitHub.`);
}

function readSandbox(path) {
  try {
    const sandbox = JSON.parse(readFileSync(path, 'utf8'));
    if (isObject(sandbox)) return sandbox;
  } catch {
    throw new Error(`contributions: cannot read a JSON object from ${path}.`);
  }
  throw new Error(`contributions: ${path} must contain a JSON object.`);
}

main(import.meta, () => runOperation({
  check: paths => paths.forEach(path => contributionPolicy(readSandbox(path))),
}, 'usage: contribution-policy.mjs check SANDBOX_JSON...'));
