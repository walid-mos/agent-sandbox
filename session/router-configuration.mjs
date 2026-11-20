import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeStandardWire, STANDARD_WIRES } from './router-wires.mjs';
import { basicEnvironment, RUNTIME_SETTINGS } from './environment.mjs';
import { CODEX_HOME } from './router-codex.mjs';

import { READ_COMMAND_MS } from './codex-limits.mjs';
const privateFailure = () => new Error('CODEX_TARGETED_V1: private configuration unreadable or unsupported, refused. No private contents were printed.');

export function requirePrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw privateFailure();
  return stat;
}

export function readPrivateJson(path) {
  try {
    requirePrivateFile(path);
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw privateFailure();
  }
}

export function magpieConfigurationCommand(arguments_, { deadline = Date.now() + READ_COMMAND_MS, ...options } = {}) {
  try {
    if (Date.now() >= deadline) throw privateFailure();
    return execFileSync('magpie', arguments_, { encoding: 'utf8', timeout: deadline - Date.now(), maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'], ...options, env: basicEnvironment(process.env, RUNTIME_SETTINGS) });
  } catch {
    throw new Error('CODEX_TARGETED_V1: Magpie configuration command failed, refused. Inspect privately. No command output was printed.');
  }
}

function magpieDirectory() {
  const directory = magpieConfigurationCommand(['data']).match(/^files: (.+)$/mu)?.[1];
  if (!directory) throw privateFailure();
  return directory;
}

function configurationFile(directory, name) {
  try {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw privateFailure();
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw privateFailure();
  }
}

function credentialFiles(paths) {
  return Object.entries(paths).map(([name, path]) => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw privateFailure();
      return [name, readFileSync(path)];
    } catch { throw new Error('CODEX_TARGETED_V1: credential scope is incomplete or unsafe, refused. No credential values were printed.'); }
  });
}

export function captureCredentialBytes({ magpieDirectory: directory, managedCodexHome, nativeCodexHome }) {
  const paths = {
    'magpie/logins.json': join(directory, 'logins.json'),
    'managed-codex/auth.json': join(managedCodexHome, 'auth.json'),
    'native-codex/auth.json': join(nativeCodexHome, 'auth.json'),
  };
  return new Map(credentialFiles(paths));
}

export function requireCredentialBytesEqual(before, after) {
  if (!(before instanceof Map) || !(after instanceof Map) || before.size !== after.size) throw new Error('CODEX_TARGETED_V1: local credential state changed or is incomplete, refused.');
  for (const [store, bytes] of before) {
    if (!Buffer.isBuffer(bytes) || !Buffer.isBuffer(after.get(store)) || !bytes.equals(after.get(store))) {
      throw new Error('CODEX_TARGETED_V1: local credential state changed or is incomplete, refused.');
    }
  }
  return true;
}

export function readLocalCredentialBytes() {
  const directory = magpieDirectory();
  const nativeCodexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return captureCredentialBytes({ magpieDirectory: directory, managedCodexHome: CODEX_HOME, nativeCodexHome });
}

export function readRouterConfiguration() {
  const deadline = Date.now() + READ_COMMAND_MS;
  const directory = magpieConfigurationCommand(['data'], { deadline }).match(/^files: (.+)$/mu)?.[1];
  if (!directory) throw privateFailure();
  const wires = Object.fromEntries(Object.entries(STANDARD_WIRES).map(([member, expected]) =>
    [member, normalizeStandardWire(magpieConfigurationCommand(['model', 'wire', member], { deadline }), member, expected)]));
  return {
    format: 'agent-sandbox-codex-v1',
    providers: configurationFile(directory, 'providers.json'),
    settings: configurationFile(directory, 'settings.json'),
    wires,
  };
}
