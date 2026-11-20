import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { durablePrivateFile, requirePrivateDirectory } from './codex-journal.mjs';
import { readLocalCredentialBytes, requireCredentialBytesEqual, requirePrivateFile } from './router-configuration.mjs';

const baselineFilename = store => store.replaceAll('/', '--');

function requireCredentialMap(credentials) {
  if (!(credentials instanceof Map) || [...credentials].some(([store, bytes]) => typeof store !== 'string' || !Buffer.isBuffer(bytes))) {
    throw new Error('CODEX_TARGETED_V1: private credential baseline is incomplete, refused.');
  }
}

export function captureCredentialBaseline(directory, captureCredentials = readLocalCredentialBytes) {
  requirePrivateDirectory(dirname(directory));
  mkdirSync(directory, { mode: 0o700 });
  requirePrivateDirectory(directory);
  const credentials = captureCredentials();
  requireCredentialMap(credentials);
  for (const [store, bytes] of credentials) durablePrivateFile(join(directory, baselineFilename(store)), bytes);
  return true;
}

export function compareCredentialBaseline(directory, captureCredentials = readLocalCredentialBytes) {
  requirePrivateDirectory(directory);
  const current = captureCredentials();
  requireCredentialMap(current);
  const expectedFiles = [...current.keys()].map(baselineFilename).toSorted();
  const storedFiles = readdirSync(directory).toSorted();
  if (JSON.stringify(storedFiles) !== JSON.stringify(expectedFiles)) throw new Error('CODEX_TARGETED_V1: local credential state changed or is incomplete, refused.');
  const baseline = new Map([...current.keys()].map(store => {
    const path = join(directory, baselineFilename(store));
    requirePrivateFile(path);
    return [store, readFileSync(path)];
  }));
  return requireCredentialBytesEqual(baseline, current);
}
