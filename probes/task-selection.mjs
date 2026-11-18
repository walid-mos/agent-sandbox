import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { existingExecution, fixture, submission } from './fixtures/task-harness.mjs';

test('versioned control refuses missing or unsafe v1 envelopes before intake', t => {
  const { control, invoke, run, read } = fixture(t);
  const missing = invoke('session/control.mjs', ['task-submit', JSON.stringify(submission)]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /contract version/);
  const incompatible = run('task-submit', { ...submission, version: 1 });
  assert.equal(incompatible.status, 1);
  assert.match(incompatible.stderr, /contract version/);
  const snapshot = control('snapshot');
  assert.equal(snapshot.taskContract.version, 2);
  assert.equal(snapshot.taskContract.target, 'synthetic');
  assert.equal(snapshot.taskContract.operations.includes('task-select'), true);
  assert.equal(snapshot.taskContract.operations.includes('task-adopt'), true);
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(read().wakes.length, 0);
  assert.equal(control('task-submit', submission).version, 2);
  assert.equal(control('snapshot').tasks[0].version, 2);
});

function acceptedExecution(t) {
  const boundary = fixture(t);
  const execution = existingExecution(boundary.folder);
  boundary.patch({ terminals: [execution.terminal] });
  boundary.control('task-submit', submission);
  boundary.control('task-decide', { id: submission.id, state: 'accepted', reason: 'Own selected work.' });
  return { ...boundary, ...execution };
}

function reconnectingTransport(run, retainedFile) {
  let isDisconnected = true;
  return () => {
    const retained = JSON.parse(readFileSync(retainedFile, 'utf8'));
    if (isDisconnected) {
      isDisconnected = false;
      throw new Error('Synthetic request lost before control execution.');
    }
    return run('task-adopt', retained);
  };
}

for (const change of ['session path', 'session header']) {
  test(`adoption retry lost before commit refuses a changed ${change} at the same address`, t => {
    const { folder, control, run, patch, read, terminal, sessionFile } = acceptedExecution(t);
    const selected = control('task-select', { id: submission.id, terminal: terminal.address });
    const retained = { version: 2, id: submission.id, selection: selected.selection.identity };
    const retainedFile = join(folder, 'herdr-retained-adoption.json');
    writeFileSync(retainedFile, JSON.stringify(retained));
    const transport = reconnectingTransport(run, retainedFile);
    assert.throws(transport, /lost before control/);
    const before = control('snapshot').tasks[0];
    assert.equal(before.execution, undefined);
    const laterSession = change === 'session path' ? join(folder, '.pi/agent/sessions/later.jsonl') : sessionFile;
    const laterContent = '{"type":"session","id":"later-conversation"}\n';
    writeFileSync(laterSession, laterContent);
    patch({ terminals: [{ ...terminal, labels: { 'pi.session': laterSession } }] });
    const retry = transport();
    assert.deepEqual(JSON.parse(readFileSync(retainedFile, 'utf8')), retained);
    assert.equal(retry.status, 1);
    assert.match(retry.stderr, /selected execution changed/);
    assert.equal(run('task-select', { id: submission.id, terminal: terminal.address }).status, 1);
    assert.deepEqual(control('snapshot').tasks[0], before);
    assert.equal(control('snapshot').workers.length, 0);
    assert.equal(readFileSync(laterSession, 'utf8'), laterContent);
    assert.equal(read().wakes.length, 1);
    assert.equal(read().calls.some(call => call.binary === 'hc' && ['run', 'send', 'kill', 'rm'].includes(call.args[0])), false);
  });
}

test('selection refuses an existing registered worker before pinning the task', t => {
  const { folder, control, run, terminal } = acceptedExecution(t);
  const workers = join(folder, '.config/agent-sandbox/workers');
  mkdirSync(workers, { recursive: true });
  const worker = { name: 'synthetic-existing-worker', owner: 'synthetic', terminal: terminal.address };
  writeFileSync(join(workers, `${worker.name}.json`), JSON.stringify(worker));
  const selected = run('task-select', { id: submission.id, terminal: terminal.address });
  assert.equal(selected.status, 1);
  assert.equal(control('snapshot').tasks[0].selection, undefined);
  assert.equal(control('task-associate', { id: submission.id, worker: worker.name }).execution.worker, worker.name);
});

test('selection is bound to its task and refuses changed native parent metadata', t => {
  const { control, run, patch, terminal } = acceptedExecution(t);
  const selected = control('task-select', { id: submission.id, terminal: terminal.address });
  const other = { ...submission, id: 'task-synthetic-other' };
  control('task-submit', other);
  control('task-decide', { id: other.id, state: 'accepted', reason: 'Own separate synthetic work.' });
  const otherSelection = control('task-select', { id: other.id, terminal: terminal.address });
  assert.notEqual(otherSelection.selection.identity, selected.selection.identity);
  assert.equal(run('task-adopt', { id: other.id, selection: selected.selection.identity }).status, 1);
  patch({ terminals: [{ ...terminal, parent: 'synthetic-mac/another-parent' }] });
  const retry = run('task-adopt', { id: submission.id, selection: selected.selection.identity });
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /selected execution changed/);
  assert.equal(control('snapshot').workers.length, 0);
});

test('selection survives restart and lost replies without recapturing or authorizing another execution', t => {
  const { control, run, invoke, read, terminal, sessionFile } = acceptedExecution(t);
  const input = { id: submission.id, terminal: terminal.address };
  const selected = control('task-select', input);
  assert.match(selected.selection.identity, /^[a-f0-9]{64}$/);
  assert.deepEqual(control('task-select', input).selection, selected.selection);
  const retained = { id: submission.id, selection: selected.selection.identity };
  for (const request of [{ id: submission.id }, { ...retained, selection: 'forged' }, { ...retained, cwd: '/etc' },
    { ...retained, parent: 'claimed-parent' }, { ...retained, sessionFile: '/etc/private.jsonl' }]) {
    assert.equal(run('task-adopt', request).status, 1);
  }
  assert.equal(run('task-select', { ...input, sessionId: 'claimed-session' }).status, 1);
  assert.equal(run('task-associate', { id: submission.id, worker: 'unrelated' }).status, 1);
  const start = invoke('session/dispatch.mjs', ['start', '--task', submission.id, '--title', 'feat: selected',
    '--subject', 'feat: selected', 'example/project', 'feat/selected', '/missing-brief.md', 'main']);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /selected execution/);
  appendFileSync(sessionFile, '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Continue the same synthetic conversation."}]}}\n');
  assert.deepEqual(control('task-select', input).selection, selected.selection);
  const adopted = control('task-adopt', retained);
  assert.equal(control('task-adopt', retained).execution.worker, adopted.execution.worker);
  assert.equal(control('snapshot').workers.length, 1);
  writeFileSync(sessionFile, '{"type":"session","id":"later-conversation"}\n');
  assert.equal(run('task-adopt', retained).status, 1);
  assert.equal(control('snapshot').tasks[0].execution.status, 'attention-needed');
  assert.equal(read().calls.some(call => !['pots', 'hc'].includes(call.binary)), false);
  assert.equal(read().calls.some(call => call.binary === 'hc' && ['run', 'send', 'kill', 'rm'].includes(call.args[0])), false);
});
