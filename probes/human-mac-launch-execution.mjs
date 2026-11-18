import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piArguments } from '../mac/launch-pi.mjs';
import { launchRequest } from '../session/launch-contract.mjs';
import { checkedExecution, executionScope, gateEnvironment } from '../mac/launch-execution-contract.mjs';
import { offerMessage } from '../mac/launch-messages.mjs';
import { runPaths, sandboxProfile } from '../mac/launch-isolation.mjs';
import { verifyPress } from '../mac/launch-approval.mjs';
import { now, scenario, settings } from './fixtures/mac-launch.mjs';

const prompt = 'Reply ready.';
const request = launchRequest({ launch: 'a'.repeat(32), pot: 'alpha', target: 'mac-studio', title: 'Reply', prompt, createdAt: now });
const claim = { ...request, state: 'claimed', decidedAt: now, userId: settings.humanDiscord.userId };

test('a fresh claim cannot launch without a separate restricted execution contract', () => {
  assert.throws(() => piArguments({ request, prompt }, { ...settings, execution: undefined }, claim, '/tmp/session.jsonl', now), /restricted execution/);
});

test('the offer names the restricted identity, selected work and actual capabilities', () => {
  const message = offerMessage({ request, prompt }, settings, 'https://example.test/notice').content;
  assert.match(message, /_maclaunch/);
  assert.match(message, /\/Library\/AgentSandbox\/Execution\/work\/fixture/);
  assert.match(message, /model/);
  assert.doesNotMatch(message, /no restriction/);
});

test('changing the execution scope invalidates the earlier operator offer', async t => {
  const flow = scenario(t);
  await flow.service.notice(flow.notice, '555555555555555555');
  const event = flow.press();
  flow.source.config.directory = '/Library/AgentSandbox/Execution/work/another';
  assert.throws(() => verifyPress(event, flow.store.get(request.launch), flow.source.config, now, 'ml'), /execution scope/);
});

test('work without an explicit safe delegation is refused', () => {
  assert.throws(() => executionScope(settings, ['spend']), /no safe delegated capability for spend/);
  assert.throws(() => executionScope(settings, ['sign-tip']), /no safe delegated capability for sign-tip/);
  assert.equal(gateEnvironment().HOME, '/Library/AgentSandbox/MacLaunch');
  assert.equal(gateEnvironment().SSH_AUTH_SOCK, undefined);
});

test('only explicitly declared capabilities cross into a launch', () => {
  const config = structuredClone(settings);
  config.execution.grants = [{ name: 'boat', acts: ['spend'], credential: '/Library/AgentSandbox/Delegations/boat.json', files: [], network: [{ address: '192.0.2.2', port: 443 }] }];
  assert.deepEqual(executionScope(config, []).names, ['model', 'system-dns']);
  assert.deepEqual(executionScope(config, ['spend']).names, ['model', 'system-dns', 'boat']);
  assert.deepEqual(executionScope(config, ['spend']).network, [{ address: '192.0.2.1', port: 443 }, { address: '192.0.2.2', port: 443 }]);
});

test('unsupported work is reported refused before any offer or launch', async t => {
  const flow = scenario(t);
  flow.source.shown.acts = ['spend'];
  await flow.service.notice(flow.notice, '555555555555555555');
  await flow.service.tick();
  assert.equal(flow.posted.length, 0);
  assert.equal(flow.runs.length, 0);
  assert.equal(flow.reports.at(-1).packet.status, 'refused');
  assert.match(flow.reports.at(-1).packet.detail, /no safe delegated capability for spend/);
});

test('the native profile exposes selected paths and endpoints without the whole System data volume', () => {
  const profile = sandboxProfile(settings, runPaths(request.launch), []);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /192\.0\.2\.1:443/);
  assert.doesNotMatch(profile, /\(subpath "\/System"\)/);
  assert.doesNotMatch(profile, /\(allow network-outbound\)/);
  assert.throws(() => runPaths('../gate'), /invalid execution ID/);
});

const invalidSettings = {
  'root identity': config => { config.execution.uid = 0; },
  'operator account': config => { config.execution.user = 'operator'; },
  'operator home': config => { config.directory = '/Users/operator'; },
  'traversed work path': config => { config.directory += '/../other'; },
  'operator tool': config => { config.tools.node = '/Users/operator/bin/node'; },
  'undeclared DNS resolver': config => { delete config.execution.model.resolver; },
  'operator model credential': config => { config.execution.model.credential = '/Users/operator/.pi/agent/auth.json'; },
  'loopback service': config => { config.execution.model.network = [{ address: '127.0.0.1', port: 443 }]; },
  'metadata endpoint': config => { config.execution.model.network = [{ address: '169.254.169.254', port: 80 }]; },
  'privileged delegation': config => { config.execution.grants = [{ name: 'root', acts: ['launch-gate'], files: [], network: [] }]; },
};
for (const [name, change] of Object.entries(invalidSettings)) test(`rejects ${name} in the execution manifest`, () => {
  const config = structuredClone(settings);
  change(config);
  assert.throws(() => checkedExecution(config));
});
