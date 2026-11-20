import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WITH_VAULT = 'unused-fixture-command';

export function command(binary, [operation, botFlag, bot, sourceFlag, source, idFlag, id, noteFlag, note]) {
  assert.deepEqual([binary, operation, botFlag, bot, sourceFlag, source, idFlag, noteFlag],
    ['pots', 'wake', '--bot', 'fixture-principal', '--from', 'pr-factory', '--id', '--note']);
  const path = join(homedir(), 'delivered-wake.json');
  const wake = JSON.stringify({ id, note });
  try {
    writeFileSync(path, wake, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(readFileSync(path, 'utf8'), wake);
    return;
  }
  throw new Error('fixture lost the wake acknowledgement');
}
