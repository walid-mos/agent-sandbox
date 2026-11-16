import { spawnSync } from 'node:child_process';
import { basicEnvironment, RUNTIME_SETTINGS } from './environment.mjs';
import { main } from './main.mjs';
import { synchronizeCodex } from './router-codex.mjs';
import { sandbox } from './sandbox.mjs';
import { readVault } from './vault.mjs';

const CREDENTIALS = [
  { provider: 'codex', path: '/clients/pi', name: 'PI_OAUTH_CODEX', input: 'file' },
  { provider: 'inco', path: '/providers', name: 'INCO_API_KEY', input: 'keys' },
  { provider: 'openrouter', path: '/providers', name: 'OPENROUTER_API_KEY', input: 'keys' },
  { provider: 'typesafe', path: '/providers', name: 'TYPESAFE_API_KEY', input: 'keys' },
  { provider: 'claude', path: '/clients/claude', name: 'CLAUDE_CODE_OAUTH_TOKEN', input: 'accounts' },
];
const COMMAND_SECONDS = 120;
const INPUTS = {
  file: value => ({ expires: synchronizeCodex(value) }),
  keys: importKey,
  accounts: (value, provider) => ingest(['accounts', 'import', provider, '/dev/stdin', '--yes'], value, provider),
};

function credentialsFor() {
  const configured = new Set(Object.entries(sandbox.secrets).concat(Object.entries(sandbox.onRequest?.claude ?? {}))
    .flatMap(([path, names]) => names.map(name => `${path}/${name}`)));
  return CREDENTIALS.filter(entry => entry.input === 'file' || configured.has(`${entry.path}/${entry.name}`));
}

function importKey(value, provider) {
  const { status, stdout } = spawnSync('magpie', ['provider', 'keys', provider], {
    encoding: 'utf8', env: basicEnvironment(process.env, RUNTIME_SETTINGS), stdio: ['ignore', 'pipe', 'ignore'], timeout: COMMAND_SECONDS * 1000,
  });
  if (status !== 0) throw new Error(`router-credentials: cannot list ${provider}'s keys. Seed its provider first.`);
  if (stdout.split(/\r?\n/u).includes(value)) return {};
  return ingest(['provider', 'keys', provider, 'add', '-'], value, provider);
}

function ingest(arguments_, value, provider) {
  const { status } = spawnSync('/bin/sh', ['-c', 'cat | "$@"', 'router-credentials', 'magpie', ...arguments_], {
    input: value, env: basicEnvironment(process.env, RUNTIME_SETTINGS), stdio: ['pipe', 'ignore', 'ignore'], timeout: COMMAND_SECONDS * 1000,
  });
  if (status !== 0) throw new Error(`router-credentials: Magpie refused ${provider} (exit ${status}). Check the vault credential and seed the router if its providers are missing.`);
  return {};
}

main(import.meta, () => {
  const entries = credentialsFor();
  const folders = {};
  for (const { path, name } of entries) (folders[path] ??= []).push(name);
  const secrets = new Map(readVault([folders]).secrets);
  const values = entries.map(entry => {
    const value = secrets.get(entry.name);
    if (!value) throw new Error(`router-credentials: ${entry.path}/${entry.name} is empty in the vault.`);
    return value;
  });
  const report = Object.assign({}, ...entries.map((entry, index) => INPUTS[entry.input](values[index], entry.provider)));
  process.stdout.write(`${JSON.stringify({ ...report, providers: entries.map(entry => entry.provider) })}\n`);
});
