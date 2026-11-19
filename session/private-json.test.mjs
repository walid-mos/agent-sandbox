import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writePrivateJson } from './private-json.mjs';

test('private JSON writes leave another writer staging file untouched', t => {
  const directory = mkdtempSync(join(tmpdir(), 'private-json-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'protected-channels.json');
  writeFileSync(`${path}.tmp`, 'another writer');
  writePrivateJson(path, { guildId: '100000000000000001' });
  assert.equal(existsSync(`${path}.tmp`), true);
  assert.equal(readFileSync(`${path}.tmp`, 'utf8'), 'another writer');
  assert.equal(readFileSync(path, 'utf8'), '{"guildId":"100000000000000001"}');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory).sort(), ['protected-channels.json', 'protected-channels.json.tmp']);
});
