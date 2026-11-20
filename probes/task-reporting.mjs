import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { existingExecution, fixture, submission } from './fixtures/task-harness.mjs';

function accept({ control }) {
  control('task-submit', submission);
  return control('task-decide', { id: submission.id, state: 'accepted', reason: 'Own the synthetic work.' });
}

function managed(t) {
  const harness = fixture(t);
  const { folder, control, patch, invoke } = harness;
  const { terminal, sessionFile } = existingExecution(folder);
  const worker = { name: 'pots-fixture-worker', owner: 'synthetic', launchId: 'fixture-launch', terminal: terminal.address,
    worktree: terminal.cwd, sessionFile, sessionId: 'synthetic-session' };
  const saved = invoke('probes/fixtures/task-worker.mjs', ['register'], JSON.stringify(worker));
  assert.equal(saved.status, 0, saved.stderr);
  patch({ terminals: [{ ...terminal, name: worker.name, turn: 5, status: 'idle', labels: { ...terminal.labels,
    'pots.owner': worker.owner, 'pots.launch': worker.launchId } }] });
  const accepted = accept(harness);
  assert.deepEqual(accept(harness).acceptance, accepted.acceptance);
  control('task-associate', { id: submission.id, worker: worker.name });
  harness.workerStep('settle');
  return { ...harness, worker };
}

function broker(invoke, operation, args, input) {
  const reply = invoke('session/human.mjs', [operation, ...args], JSON.stringify(input));
  assert.equal(reply.status, 0, reply.stderr);
  return JSON.parse(reply.stdout);
}

const taskReports = read => read().wakes.filter(wake => wake.note.kind === 'task-report');

test('an idle terminal with an open broker dialog reports one human wait until settlement', t => {
  const { control, invoke, read, patch, worker, workerStep } = managed(t);
  const source = { type: 'worker', worker: worker.name, session: worker.sessionFile, call: 'fixture-call' };
  const questions = [{ id: 'format', prompt: 'Which synthetic format?' }];
  const dialog = broker(invoke, 'open', [], { kind: 'question', policy: 'ordinary', source, questions });
  workerStep('inspect');
  workerStep('relay');
  const uncertain = control('snapshot').tasks[0].execution.wait;
  assert.deepEqual(uncertain.delivery, { id: 'synthetic.12345678', state: 'unknown' });
  workerStep('relay');
  workerStep('relay');
  const waiting = control('snapshot');
  assert.equal(waiting.workers[0].status, 'blocked');
  assert.equal(waiting.tasks[0].execution.status, 'blocked');
  assert.equal(waiting.tasks[0].execution.wait.dialog, dialog.id);
  assert.ok(Number.isSafeInteger(waiting.tasks[0].execution.wait.startedAt));
  assert.deepEqual(waiting.tasks[0].execution.wait, { ...uncertain, delivery: { ...uncertain.delivery, state: 'open' } });
  assert.deepEqual(read().noticeAttempts, [uncertain.delivery.id, uncertain.delivery.id]);
  assert.deepEqual(waiting.workers[0].wait, waiting.tasks[0].execution.wait);
  patch({ loseReply: true });
  const lost = invoke('probes/fixtures/task-worker.mjs', ['report']);
  assert.equal(lost.status, 1);
  workerStep('report');
  workerStep('report');
  assert.equal(taskReports(read).length, 1);
  assert.deepEqual(taskReports(read)[0].note.task, waiting.tasks[0]);
  const answer = { answers: [{ id: 'format', labels: [], text: 'Plain text.' }] };
  const settled = broker(invoke, 'answer', [dialog.id], answer);
  assert.deepEqual(broker(invoke, 'answer', [dialog.id], answer).result, settled.result);
  workerStep('report');
  const resumed = control('snapshot');
  assert.equal(resumed.tasks[0].execution.status, 'idle');
  assert.equal(resumed.tasks[0].execution.wait, undefined);
  assert.deepEqual(taskReports(read).at(-1).note.task, resumed.tasks[0]);
});

test('an ended standalone Pi conversation retains its observed identity without worker authority', t => {
  const harness = fixture(t);
  const { folder, control, patch, read, run, workerStep } = harness;
  const { terminal, transcript, sessionFile } = existingExecution(folder);
  accept(harness);
  patch({ terminals: [{ ...terminal, status: 'error' }] });
  const failed = control('snapshot').standaloneExecutions[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.sessionId, 'synthetic-session');
  assert.equal(failed.wait, undefined);
  patch({ terminals: [{ ...terminal, state: 'finished', status: 'done', finished_ms: 2300 }] });
  const snapshot = control('snapshot');
  assert.deepEqual(snapshot.standaloneExecutions.map(row => [row.terminal, row.parent, row.sessionId, row.state]),
    [[terminal.address, terminal.parent, 'synthetic-session', 'finished']]);
  assert.equal(snapshot.standaloneExecutions[0].status, 'ended');
  assert.equal(snapshot.tasks[0].execution, undefined);
  assert.equal(run('task-select', { id: submission.id, terminal: terminal.address }).status, 1);
  workerStep('serve');
  assert.equal(control('snapshot').workers.length, 0);
  patch({ terminals: [] });
  assert.deepEqual(control('snapshot').standaloneExecutions, []);
  assert.equal(readFileSync(sessionFile, 'utf8'), transcript);
  assert.equal(read().calls.some(call => call.binary === 'hc' && ['run', 'send', 'kill', 'rm'].includes(call.args[0])), false);
});

test('a managed follow-up sent at an unchanged turn stays pending until Pi records its receipt', t => {
  const { folder, control, invoke, read, worker, workerStep } = managed(t);
  const original = readFileSync(worker.sessionFile, 'utf8');
  const waitingSince = 1700000000000;
  const runtimeWait = invoke('probes/fixtures/task-worker.mjs', ['runtime-wait'], `${waitingSince}`);
  assert.equal(runtimeWait.status, 0, runtimeWait.stderr);
  const internal = control('snapshot').tasks[0].execution;
  assert.equal(internal.status, 'waiting');
  assert.deepEqual(internal.wait, { kind: 'internal', owner: worker.owner, startedAt: waitingSince });
  workerStep('settle');
  const message = join(folder, 'follow-up.md');
  writeFileSync(message, 'Return the synthetic evidence.');
  const dispatch = invoke('session/dispatch.mjs', ['send', worker.name, message]);
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.equal(control('snapshot').tasks[0].execution.deliveries[0].state, 'queued');
  workerStep('serve');
  workerStep('serve');
  const pending = control('snapshot');
  assert.equal(pending.workers[0].observedStatus, 'idle');
  assert.equal(pending.workers[0].status, 'waiting');
  assert.equal(pending.tasks[0].execution.status, 'waiting');
  assert.equal(pending.tasks[0].execution.wait, undefined);
  assert.deepEqual(pending.tasks[0].execution.deliveries, [{ id: pending.tasks[0].execution.deliveries[0].id, state: 'sent', sentTo: worker.launchId }]);
  assert.equal(read().terminals[0].turn, 5);
  assert.equal(readFileSync(worker.sessionFile, 'utf8'), original);
  const sends = read().calls.filter(call => call.binary === 'hc' && call.args[0] === 'send');
  assert.equal(sends.length, 1);
  workerStep('report');
  assert.deepEqual(taskReports(read).at(-1).note.task, pending.tasks[0]);
  const received = invoke('probes/fixtures/task-worker.mjs', ['receive'], sends[0].args.at(-1));
  assert.equal(received.status, 0, received.stderr);
  assert.deepEqual(control('snapshot').tasks[0].execution.deliveries,
    [{ ...pending.tasks[0].execution.deliveries[0], state: 'received' }]);
  workerStep('serve');
  assert.deepEqual(control('snapshot').tasks[0].execution.deliveries, []);
});
