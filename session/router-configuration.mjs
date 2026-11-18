import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STANDARD_WIRES } from './router-wires.mjs';
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

function credential(path) {
  return existsSync(path) ? { present: true, contents: readPrivateJson(path) } : { present: false };
}

export function readRouterConfiguration() {
  const deadline = Date.now() + READ_COMMAND_MS;
  const directory = magpieConfigurationCommand(['data'], { deadline }).match(/^files: (.+)$/mu)?.[1];
  if (!directory) throw privateFailure();
  const wires = Object.fromEntries(Object.keys(STANDARD_WIRES).map(member =>
    [member, magpieConfigurationCommand(['model', 'wire', member], { deadline }).trim()]));
  return {
    format: 'agent-sandbox-codex-v1',
    providers: configurationFile(directory, 'providers.json'),
    settings: configurationFile(directory, 'settings.json'),
    wires,
    credentials: {
      managedCodex: credential(join(CODEX_HOME, 'auth.json')),
      nativeCodex: credential(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')),
    },
  };
}
