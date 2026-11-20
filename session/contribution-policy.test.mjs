import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contributionPolicy, grantFor, requireOperation } from './contribution-policy.mjs';

const OWNERS = { NextNodeSolutions: 'GITHUB_TOKEN', 'walid-mos': 'GITHUB_TOKEN_WALID_MOS' };
const GRANT = { fork: 'walid-mos/pi-durable-bot', operations: ['issue', 'push', 'pull-request'] };
const sandboxWith = contributions => ({ owners: OWNERS, contributions });

test('a grant takes its credential from the owner of the fork', () => {
  const [grant] = contributionPolicy(sandboxWith({ 'Crokily/pi-durable-bot': GRANT }));
  assert.equal(grant.credential, 'GITHUB_TOKEN_WALID_MOS');
  assert.equal(grant.upstream, 'Crokily/pi-durable-bot');
});

test('a sandbox without contributions grants nothing', () => {
  assert.deepEqual(contributionPolicy({ owners: OWNERS }), []);
});

const REFUSED = {
  'a fork owner outside owners': { 'Crokily/pi-durable-bot': { ...GRANT, fork: 'someone/pi-durable-bot' } },
  'an upstream owner inside owners': { 'NextNodeSolutions/agent-sandbox': { ...GRANT, fork: 'walid-mos/agent-sandbox' } },
  'a fork equal to the upstream': { 'walid-mos/pi-durable-bot': GRANT },
  'an unknown operation': { 'Crokily/pi-durable-bot': { ...GRANT, operations: ['issue', 'delete'] } },
  'an empty operation list': { 'Crokily/pi-durable-bot': { ...GRANT, operations: [] } },
  'an extra grant key': { 'Crokily/pi-durable-bot': { ...GRANT, credential: 'GITHUB_TOKEN' } },
  'a URL as upstream key': { 'https://github.com/Crokily/pi-durable-bot': GRANT },
  'a .git suffix': { 'Crokily/pi-durable-bot.git': GRANT },
  'one fork for two upstreams': { 'Crokily/pi-durable-bot': GRANT, 'Other/pi-durable-bot': GRANT },
  'a list instead of an object': [],
};

for (const [name, contributions] of Object.entries(REFUSED)) {
  test(`policy refuses ${name}`, () => {
    assert.throws(() => contributionPolicy(sandboxWith(contributions)), /contributions:/u);
  });
}

test('an upstream outside the policy is refused before any GitHub call', () => {
  const policy = contributionPolicy(sandboxWith({ 'Crokily/pi-durable-bot': GRANT }));
  assert.throws(() => grantFor(policy, 'Crokily/another-repository'), /not in this pot's contributions policy/u);
  assert.equal(grantFor(policy, 'crokily/PI-durable-bot').upstream, 'Crokily/pi-durable-bot');
});

test('an operation outside the grant is refused', () => {
  const [grant] = contributionPolicy(sandboxWith({ 'Crokily/pi-durable-bot': GRANT }));
  assert.throws(() => requireOperation(grant, 'fork'), /does not permit fork/u);
  assert.doesNotThrow(() => requireOperation(grant, 'issue'));
});
