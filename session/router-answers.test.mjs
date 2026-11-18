import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, beforeEach, test } from 'node:test';
import { routerAnswers } from './router-answers.mjs';
import { codexAnswers } from './router-codex-answers.mjs';
import { codexConfiguration } from '../probes/fixtures/codex-configuration.mjs';

const asked = [];
const requests = [];
let replies = {};
const router = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const { model } = JSON.parse(body);
    asked.push(model);
    const account = request.headers['x-magpie-account'];
    requests.push({ model, account });
    const replyKey = account ? `${account}|${model}` : model;
    const reply = replies[replyKey] ?? { status: 404, served: '', body: { error: { message: `no reply scripted for ${replyKey}` } } };
    reply.onRequest?.();
    if (reply.disconnect) return request.socket.destroy();
    response.writeHead(reply.status, { 'Content-Type': 'application/json', 'X-Magpie-Model': reply.served });
    response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
});
router.listen(0, '127.0.0.1');
await once(router, 'listening');
const routerApi = `http://127.0.0.1:${router.address().port}/v1`;
after(() => router.close());
beforeEach(() => {
  asked.length = 0;
  requests.length = 0;
  replies = {};
});

const servedBy = model => ({ status: 200, served: model, body: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } });
const pingRule = { intent: 'a test ping', use: ['group/max'] };
const seeded = (expertMembers = ['codex/sol:high', 'claude/opus:high']) => ({
  groups: [
    { id: 'router', members: ['group/expert', 'group/max'], routing: 'order', rules: [pingRule] },
    { id: 'expert', members: expertMembers, routing: 'order' },
    { id: 'max', members: ['claude/fable:xhigh', 'group/expert'], routing: 'order' },
  ],
});

async function answers(configuration) {
  const lines = [];
  for await (const line of routerAnswers(configuration, routerApi)) lines.push(line);
  return lines;
}

test('asks each default group through its first rule-free order group and names the model that served it', async () => {
  replies = { 'group/expert': servedBy('codex/sol'), 'group/max': servedBy('claude/fable') };
  assert.deepEqual(await answers(seeded()), [
    'router-restore: group/router answers through group/expert with codex/sol',
    'router-restore: group/max answers with claude/fable',
  ]);
  assert.deepEqual(asked, ['group/expert', 'group/max']);
});

test('fails naming the group, the expected member and the served model when a later member answers', async () => {
  replies = { 'group/expert': servedBy('claude/opus'), 'group/max': servedBy('claude/fable') };
  await assert.rejects(answers(seeded()), {
    message: 'router-restore: group/router through group/expert expected codex/sol:high and got claude/opus. Its first member gave no answer: check that model on its provider and the vault credentials.',
  });
  assert.deepEqual(asked, ['group/expert']);
});

test('names the group, expected member and selected model on an HTTP failure', async () => {
  replies = { 'group/expert': { status: 400, served: 'codex/sol', body: { error: { message: "Codex: The 'sol' model is not supported." } } } };
  await assert.rejects(answers(seeded()), {
    message: 'router-restore: group/router through group/expert expected codex/sol:high and got no answer (HTTP 400, selected codex/sol). Check that model on its provider and credential freshness.',
  });
});

test('preflights both defaults and rejects missing, empty, cyclic or unpredictable groups before calling', async () => {
  const invalidGroups = [
    [],
    [{ id: 'max', members: [], routing: 'order' }],
    [{ id: 'max', members: ['group/max'], routing: 'order' }],
    [{ id: 'max', members: ['fake/one'], routing: 'rotate' }],
    [{ id: 'max', members: ['fake/one'], routing: 'order', rules: [pingRule] }],
  ];
  for (const groups of invalidGroups) {
    const configuration = seeded();
    configuration.groups = configuration.groups.filter(group => group.id !== 'max').concat(groups);
    await assert.rejects(answers(configuration), /router-restore: group\/max: .*Check the seeded groups/);
    assert.deepEqual(asked, []);
  }
});

test('keeps the HTTP status when the router answers with a body that is not JSON', async () => {
  replies = { 'group/expert': { status: 502, served: 'codex/sol', body: '<html>bad gateway</html>' } };
  await assert.rejects(answers(seeded()), {
    message: 'router-restore: group/router through group/expert expected codex/sol:high and got no answer (HTTP 502, selected codex/sol). Check that model on its provider and credential freshness.',
  });
});

test('reports a disconnected router with the group and expected member', async () => {
  replies = { 'group/expert': { disconnect: true } };
  await assert.rejects(answers(seeded()), {
    message: 'router-restore: group/router through group/expert expected codex/sol:high and got no served model: request failed or response was unreadable. Check the router.',
  });
});

test('full health still rejects the exact Claude failure and Claude fallback after Codex succeeds', async () => {
  for (const reply of [
    { status: 429, served: 'claude/fable', body: { error: 'quota' } },
    servedBy('claude/opus'),
  ]) {
    asked.length = 0;
    replies = { 'group/expert': servedBy('codex/sol'), 'group/max': reply };
    await assert.rejects(answers(seeded()), /group\/max expected claude\/fable:xhigh/u);
    assert.deepEqual(asked, ['group/expert', 'group/max']);
  }
});

async function directAnswers(account = 'original', captureCredentials = () => new Map([['fixture', Buffer.from('owned')]])) {
  const snapshot = codexConfiguration();
  snapshot.providers.groups[1].members[0] = `codex/gpt-6.2-sol:medium#${account}`;
  snapshot.providers.groups[2].members[0] = `codex/gpt-6.2-sol:high#${account}`;
  const lines = [];
  for await (const line of codexAnswers(snapshot, routerApi, captureCredentials)) lines.push(line);
  return lines;
}

test('Codex contract sends one direct original-account high-effort request and reports Claude DEFERRED', async () => {
  replies = { 'original|codex/gpt-6.2-sol:high': servedBy('codex/gpt-6.2-sol') };
  assert.deepEqual(await directAnswers(), [
    'CODEX_TARGETED_V1: direct Codex served codex/gpt-6.2-sol',
    'CODEX_TARGETED_V1: account constraint applied, served account unverified',
    'CODEX_TARGETED_V1: Claude DEFERRED, group runtime and fallbacks untested',
  ]);
  assert.deepEqual(asked, ['codex/gpt-6.2-sol:high']);
  assert.deepEqual(requests, [{ model: 'codex/gpt-6.2-sol:high', account: 'original' }]);
});

test('Codex contract percent-encodes a Unicode account selector for Magpie', async () => {
  replies = { 'Ren%C3%A9e%20Ops%40example.com|codex/gpt-6.2-sol:high': servedBy('codex/gpt-6.2-sol') };
  await directAnswers('Renée Ops@example.com');
  assert.deepEqual(requests, [{ model: 'codex/gpt-6.2-sol:high', account: 'Ren%C3%A9e%20Ops%40example.com' }]);
});

test('Codex contract refuses missing or malformed account selectors before requests', async () => {
  for (const account of ['', 'other/account']) {
    await assert.rejects(directAnswers(account), /CODEX_TARGETED_V1: .*refused/u);
    assert.deepEqual(requests, []);
  }
});

test('credential refresh during a direct request refuses without exposing private bytes', async () => {
  let bytes = 'before';
  const captureCredentials = () => new Map([['fixture', Buffer.from(bytes)]]);
  replies = { 'original|codex/gpt-6.2-sol:high': { ...servedBy('codex/gpt-6.2-sol'), onRequest: () => { bytes = 'after'; } } };
  await assert.rejects(directAnswers('original', captureCredentials), /local credential state changed/u);
  assert.deepEqual(asked, ['codex/gpt-6.2-sol:high']);
});

test('an available same-model account cannot answer when the selected account is unavailable', async () => {
  replies = { 'other|codex/gpt-6.2-sol:high': servedBy('codex/gpt-6.2-sol') };
  await assert.rejects(directAnswers(), /CODEX_TARGETED_V1: direct Codex validation failed/u);
  assert.deepEqual(requests, [{ model: 'codex/gpt-6.2-sol:high', account: 'original' }]);
});

test('Codex contract rejects a fallback or quota response without retrying or printing full-health success', async () => {
  for (const reply of [servedBy('claude/opus'), { status: 429, served: 'codex/gpt-6.2-sol', body: {} }, { status: 200, served: 'codex/gpt-6.2-sol', body: { choices: [] } }]) {
    asked.length = 0;
    replies = { 'original|codex/gpt-6.2-sol:high': reply };
    await assert.rejects(directAnswers(), /CODEX_TARGETED_V1: direct Codex validation failed/u);
    assert.deepEqual(asked, ['codex/gpt-6.2-sol:high']);
  }
});

test('strips account, fast and effort selectors while keeping a model colon suffix', async () => {
  replies = { 'group/expert': servedBy('vendor/model:free'), 'group/max': servedBy('claude/fable') };
  assert.deepEqual(await answers(seeded(['vendor/model:free:medium:fast#work'])), [
    'router-restore: group/router answers through group/expert with vendor/model:free',
    'router-restore: group/max answers with claude/fable',
  ]);
});
