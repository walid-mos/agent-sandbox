import assert from 'node:assert/strict';
import { test } from 'node:test';
import { owesDraft } from './draft-helper.mjs';

const repository = { repository: 'example/fixture', kind: 'repository' };

test('a worker whose draft opens at dispatch owes the installed helper', () => {
  assert.equal(owesDraft(repository), true);
});

test('a worker that opens its draft through gh after an approved push owes no helper', () => {
  for (const publication of ['local', 'awaiting-pr', 'published']) {
    assert.equal(owesDraft({ ...repository, publication }), false);
  }
});

test('a worker with its pull request, a public policy or no repository owes no helper', () => {
  assert.equal(owesDraft({ ...repository, pullRequest: 'https://github.com/example/fixture/pull/1' }), false);
  assert.equal(owesDraft({ ...repository, publicationPolicy: 'accor-first-publication' }), false);
  assert.equal(owesDraft({ ...repository, repository: undefined }), false);
  assert.equal(owesDraft({ ...repository, kind: 'task' }), false);
});
