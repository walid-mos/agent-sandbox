import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, mock } from 'node:test';
import { fixtureSandbox } from './fixtures/sandbox.mjs';

const home = mkdtempSync(join(tmpdir(), 'page-proof-'));
process.env.HOME = home;
after(() => { mock.restoreAll(); rmSync(home, { recursive: true, force: true }); });
mock.module('../session/sandbox.mjs', { exports: fixtureSandbox(home) });
const { stagedValues } = await import('../session/human-pages.mjs');

const DIALOG = 'a'.repeat(32);

test('the staged file keeps its values and drops the page claim line', () => {
  mkdirSync(join(home, '.pots/secrets'), { recursive: true });
  writeFileSync(join(home, '.pots/secrets', `human-${DIALOG}.env`), `# pots-secret-claim: c1a2b3\nSLACK_APP_TOKEN=xoxa-1\nSLACK_BOT_TOKEN=xoxb-2\n`);
  assert.deepEqual(stagedValues({ id: DIALOG }), { SLACK_APP_TOKEN: 'xoxa-1', SLACK_BOT_TOKEN: 'xoxb-2' });
});

test('a value holding an equals sign keeps all of it', () => {
  mkdirSync(join(home, '.pots/secrets'), { recursive: true });
  writeFileSync(join(home, '.pots/secrets', `human-${'b'.repeat(32)}.env`), `TOKEN=abc=def\n`);
  assert.deepEqual(stagedValues({ id: 'b'.repeat(32) }), { TOKEN: 'abc=def' });
});
