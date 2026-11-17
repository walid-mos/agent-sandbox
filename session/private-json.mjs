import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// A reader never sees a half-written file: the value lands under a temporary name, then takes the real one.
export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const stagingDirectory = mkdtempSync(`${path}.`);
  const staging = join(stagingDirectory, 'value');
  try {
    writeFileSync(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(staging, path);
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
