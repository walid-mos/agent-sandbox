import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const folder = mkdtempSync(join(tmpdir(), 'discord-admin-api-home-'));
after(() => { mock.restoreAll(); rmSync(folder, { recursive: true, force: true }); });
const home = join(folder, 'home');
mkdirSync(join(home, '.pots/secrets'), { recursive: true, mode: 0o700 });
const linkedHome = join(folder, 'linked-home');
symlinkSync(home, linkedHome);
mock.module('node:os', { exports: { homedir: () => linkedHome } });
const { discordAdminApi } = await import('./discord-admin-api.mjs');
const reference = join(linkedHome, '.pots/secrets', 'fixture.env');
writeFileSync(join(home, '.pots/secrets', 'fixture.env'), 'DISCORD_BOT_TOKEN=fixture-token\n', { mode: 0o600 });

test('a home reached through a symlink still reads its token reference', async () => {
  const api = discordAdminApi(reference, async () => ({ ok: true, status: 204 }));
  assert.deepEqual(await api('GET', '/users/@me'), {});
});
