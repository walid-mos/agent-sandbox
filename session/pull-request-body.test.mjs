import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { requireChangeBody, templateSections } from './pull-request-body.mjs';

const root = mkdtempSync(join(tmpdir(), 'pull-request-body-'));
after(() => rmSync(root, { recursive: true, force: true }));

function checkout(template) {
  const directory = mkdtempSync(join(root, 'checkout-'));
  if (template === undefined) return directory;
  mkdirSync(join(directory, '.github'), { recursive: true });
  writeFileSync(join(directory, '.github/pull_request_template.md'), template);
  return directory;
}

const template = '## Purpose\n\n<!-- Why? -->\n\n## Behavior\n\n## Checks\n';

test('a placeholder body is refused before it becomes a pull request', () => {
  for (const body of [undefined, '', '   \n\t ', 'TBD', '...', '## Purpose\n## Behavior\n## Checks\n']) {
    assert.throws(() => requireChangeBody(body), /must describe the real change/);
  }
});

test('a body that skips a template section is refused', () => {
  assert.throws(() => requireChangeBody('## Purpose\nRound the freeze.\n\n## Behavior\nFreeze each establishment.\n', checkout(template)),
    /missing sections: Checks/);
});

test('the repository template sections are the ones the body must carry', () => {
  assert.deepEqual(templateSections(checkout(template)), ['Purpose', 'Behavior', 'Checks']);
  assert.deepEqual(templateSections(checkout(undefined)), []);
});

test('a section named only in the body prose does not satisfy the template', () => {
  assert.throws(() => requireChangeBody('## Purpose\nKeep the checks green.\n\n## Behavior\nRun the checks after each commit.\n', checkout(template)),
    /missing sections: Checks/);
});

test('a template-shaped body is accepted unchanged', () => {
  const body = '## Purpose\nKeep membership stable.\n\n## Behavior\nFreeze establishments.\n\n## Checks\nPlanned: campaign suite.\n';
  assert.equal(requireChangeBody(body, checkout(template)), body);
});
