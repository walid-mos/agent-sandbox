import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, beforeEach, test } from 'node:test';
import { routerAnswers } from './router-answers.mjs';

const asked = [];
let replies = {};
const router = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const { model } = JSON.parse(body);
    asked.push(model);
    const reply = replies[model] ?? { status: 404, served: '', body: { error: { message: `no reply scripted for ${model}` } } };
    if (reply.disconnect) return request.socket.destroy();
    response.writeHead(reply.status, { 'Content-Type': 'application/json', 'X-Magpie-Model': reply.served });
    response.end(JSON.stringify(reply.body));
  });
});
router.listen(0, '127.0.0.1');
await once(router, 'listening');
const routerApi = `http://127.0.0.1:${router.address().port}/v1`;
after(() => router.close());
beforeEach(() => {
  asked.length = 0;
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

test('reports a disconnected router with the group and expected member', async () => {
  replies = { 'group/expert': { disconnect: true } };
  await assert.rejects(answers(seeded()), {
    message: 'router-restore: group/router through group/expert expected codex/sol:high and got no served model: request failed or response was unreadable. Check the router.',
  });
});

test('strips account, fast and effort selectors while keeping a model colon suffix', async () => {
  replies = { 'group/expert': servedBy('vendor/model:free'), 'group/max': servedBy('claude/fable') };
  assert.deepEqual(await answers(seeded(['vendor/model:free:medium:fast#work'])), [
    'router-restore: group/router answers through group/expert with vendor/model:free',
    'router-restore: group/max answers with claude/fable',
  ]);
});
