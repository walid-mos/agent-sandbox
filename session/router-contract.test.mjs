import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as answers from './router-answers.mjs';

const groups = [
  { id: 'router', routing: 'order', rules: [{ use: ['group/max'] }], members: ['group/expert'] },
  { id: 'expert', routing: 'order', members: ['codex/gpt-6.2-sol:high', 'claude/opus:high'] },
  { id: 'max', routing: 'order', members: ['claude/fable:xhigh', 'group/expert'] },
];

test('offline public planner exposes both unchanged exact full-health requirements without sending a request', () => {
  assert.deepEqual(answers.routerAnswerPlans?.({ groups }), [
    { group: 'group/router', target: 'group/expert', member: 'codex/gpt-6.2-sol:high' },
    { group: 'group/max', target: 'group/max', member: 'claude/fable:xhigh' },
  ]);
});
