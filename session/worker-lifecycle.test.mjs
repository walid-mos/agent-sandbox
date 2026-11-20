import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';

sandboxFixture('worker-lifecycle-');
const { canFinish, followUp, hasUncollectedHelpers, SETTLED_GRACE_MS, wrappedFollowUp } = await import('./worker-lifecycle.mjs');
const { hasFinalReply } = await import('./worker-runtime.mjs');
const { terminalOf } = await import('./workers.mjs');

const finishedAt = 1000;
const now = finishedAt + SETTLED_GRACE_MS;
const state = { phase: 'settled', settledAt: finishedAt, terminal: 't-owned', owner: 'nextnode', launchId: 'launch-1' };
const terminal = { address: 't-owned', name: 'owned', cwd: '/work/task', state: 'live', status: 'idle',
  labels: { 'pots.owner': 'nextnode', 'pots.launch': 'launch-1' } };
const final = { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PR is ready.' }] } };

for (const status of ['idle', 'done']) {
  test(`settled ${status} is eligible only after the grace period`, () => {
    assert.equal(canFinish(state, { ...terminal, status }, [], now), true);
    assert.equal(canFinish(state, { ...terminal, status }, [], now - 1), false);
  });
}

for (const status of ['working', 'blocked', 'error', undefined]) {
  test(`${status} never authorizes cleanup`, () => {
    assert.equal(canFinish(state, { ...terminal, status }, [], now), false);
  });
}

for (const label of ['agent.goal', 'agent.waiting', 'lifecycle.keep']) {
  test(`${label} preserves the terminal`, () => {
    assert.equal(canFinish(state, { ...terminal, labels: { ...terminal.labels, [label]: 'pending' } }, [], now), false);
  });
}

test('idle without session completion and stable identity is insufficient', () => {
  assert.equal(canFinish(undefined, terminal, [], now), false);
  assert.equal(canFinish({ ...state, phase: 'active' }, terminal, [], now), false);
  assert.equal(canFinish({ ...state, settledAt: undefined }, terminal, [], now), false);
  assert.equal(canFinish(state, { ...terminal, state: 'finished' }, [], now), false);
  assert.equal(canFinish(state, { ...terminal, address: 't-other' }, [], now), false);
  assert.equal(canFinish(state, { ...terminal, labels: {} }, [], now), false);
  assert.equal(canFinish(state, { ...terminal, labels: { ...terminal.labels, 'pots.owner': 'personal' } }, [], now), false);
});

test('a name alone cannot establish Pots ownership', () => {
  assert.equal(terminalOf({ name: 'owned' }, [terminal]), undefined);
  assert.equal(terminalOf({ name: 'owned', ...state, terminal: 't-other' }, [terminal]), undefined);
  assert.equal(terminalOf({ name: 'owned', ...state }, [terminal])?.address, 't-owned');
});

test('the early clean-pass closure is refused while the goal remains open', () => {
  const goal = { type: 'custom', customType: 'pi-goal-state-v1', data: { items: [{ done: false }] } };
  assert.equal(hasFinalReply([goal, final]), false);
  assert.equal(hasFinalReply([{ ...goal, data: { items: [{ done: true }] } }, final]), true);
  assert.equal(hasFinalReply([{ ...goal, data: { blocked: 'Question', items: [] } }, final]), false);
  assert.equal(hasFinalReply([{ ...goal, data: { items: [], paused: [{}] } }, final]), false);
  assert.equal(hasFinalReply([final, { type: 'message', message: { role: 'user' } }]), false);
});

test('live clean-pass helpers and unread finished helper output prevent closing', () => {
  const helper = { address: 't-helper', parent: 't-owned', state: 'live', status: 'done' };
  assert.equal(hasUncollectedHelpers(terminal, [terminal, helper]), true);
  const finished = { ...helper, state: 'finished', finished_ms: 2000 };
  assert.equal(hasUncollectedHelpers(terminal, [finished]), true);
  assert.equal(hasUncollectedHelpers(terminal, [{ ...finished, labels: { 'agent.read.t-owned': '1999' } }]), true);
  assert.equal(hasUncollectedHelpers(terminal, [{ ...finished, labels: { 'agent.read.t-owned': '2000' } }]), false);
  assert.equal(hasUncollectedHelpers(terminal, [{ ...helper, parent: undefined, cwd: terminal.cwd }]), true);
  assert.equal(hasUncollectedHelpers(terminal, [{ ...helper, parent: 't-other' }]), false);
});

test('follow-up receipt removes only the Pots wrapper and preserves hc sender evidence', () => {
  const request = { file: '100-abc.json', message: 'Continue the same task.' };
  const wrapped = wrappedFollowUp(request);
  assert.deepEqual(followUp(`<hc from="t-coordinator">${wrapped}</hc>`), {
    id: '100-abc.json', text: '<hc from="t-coordinator">Continue the same task.</hc>',
  });
  assert.deepEqual(followUp(wrapped), { id: '100-abc.json', text: 'Continue the same task.' });
  assert.deepEqual(followUp('ordinary input'), { text: 'ordinary input' });
});
