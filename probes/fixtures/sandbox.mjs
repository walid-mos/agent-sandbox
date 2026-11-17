import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock } from 'node:test';

function fixtureSandbox(home) {
  const botId = 'proof';
  const potsHome = join(home, '.pots');
  const potsBotHome = id => join(potsHome, 'bots', id);
  const sandbox = { bot: botId, owners: { proof: {} }, doors: { mastermind: 'Fixture coordinator' } };
  return { sandbox, botId, owners: Object.keys(sandbox.owners), isMastermind: false, potsHome, potsBotHome, botHome: potsBotHome(botId) };
}

export function sandboxFixture(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = home;
  after(() => { mock.restoreAll(); rmSync(home, { recursive: true, force: true }); });
  mock.module('../../session/sandbox.mjs', { exports: fixtureSandbox(home) });
  return { home, session: join(home, 'worker.jsonl') };
}
