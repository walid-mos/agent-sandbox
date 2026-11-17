import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// A reader never sees a half-written file: the value lands under a temporary name, then takes the real one.
export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}
