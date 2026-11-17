import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'discord-admin-api-'));
after(() => { mock.restoreAll(); rmSync(home, { recursive: true, force: true }); });
mock.module('node:os', { exports: { homedir: () => home } });
const { discordAdminApi } = await import('./discord-admin-api.mjs');
const directory = join(home, '.pots/secrets');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const reference = join(directory, 'fixture.env');
writeFileSync(reference, `DISCORD_BOT_TOKEN=${randomBytes(24).toString('hex')}\n`, { mode: 0o600 });

test('REST adapter fixes the origin, refuses redirects and encodes the audit reason', async () => {
  const api = discordAdminApi(reference, async (url, options) => {
    assert.equal(url, 'https://discord.com/api/v10/channels/100000000000000001');
    assert.equal(options.method, 'PATCH');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Audit-Log-Reason'], 'Rename%20%2F%20requested');
    assert.equal(options.body, '{"name":"renamed"}');
    assert.equal(options.signal instanceof AbortSignal, true);
    return { ok: true, status: 204 };
  });
  assert.deepEqual(await api('PATCH', '/channels/100000000000000001', { name: 'renamed' }, 'Rename / requested'), {});
});

test('API errors reveal only status and numeric code, with no mutation retry', async () => {
  let attempts = 0;
  const api = discordAdminApi(reference, async () => {
    attempts += 1;
    return { ok: false, status: 403, json: async () => ({ code: 50013, message: 'untrusted response content' }) };
  });
  await assert.rejects(api('DELETE', '/channels/100000000000000001', undefined, 'Requested'), error => {
    assert.match(error.message, /HTTP 403, code 50013/);
    assert.doesNotMatch(error.message, /untrusted response content/);
    assert.equal(error.discordCode, 50013);
    return true;
  });
  assert.equal(attempts, 1);
});

test('transport errors do not copy provider exceptions into output', async () => {
  const api = discordAdminApi(reference, () => { throw new Error('private transport details'); });
  await assert.rejects(api('GET', '/users/@me'), error => {
    assert.match(error.message, /outcome may be unknown/);
    assert.doesNotMatch(error.message, /private transport/);
    return true;
  });
});

test('unsafe or symlinked token references fail before transport', async () => {
  const linked = join(directory, 'linked.env');
  symlinkSync(reference, linked);
  const transport = () => { throw new Error('transport must not run'); };
  await assert.rejects(discordAdminApi(linked, transport)('GET', '/users/@me'), /unsafe/);
  chmodSync(reference, 0o644);
  try { await assert.rejects(discordAdminApi(reference, transport)('GET', '/users/@me'), /unsafe/); }
  finally { chmodSync(reference, 0o600); }
});
