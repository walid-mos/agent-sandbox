import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { existingExecution, fixture, submission } from './fixtures/task-harness.mjs';

for (const [name, summary] of [['NUL', 'Final\0report'], ['UTF-8 byte overflow', 'é'.repeat(8193)]]) {
  test(`adopted result refuses ${name} before saving an outcome`, t => {
    const { folder, control, patch, run } = fixture(t);
    const { terminal, transcript } = existingExecution(folder);
    patch({ terminals: [{ ...terminal, status: 'done' }] });
    control('task-submit', submission);
    control('task-decide', { id: submission.id, state: 'accepted', reason: 'Own synthetic work.' });
    control('task-adopt', { id: submission.id, terminal: terminal.address });
    const sessionDigest = createHash('sha256').update(transcript).digest('hex');
    const reply = run('task-result', { id: submission.id, sessionDigest, summary });
    assert.equal(reply.status, 1);
    assert.match(reply.stderr, /bytes without NUL/);
    assert.equal(control('snapshot').tasks[0].execution.result, undefined);
  });
}
