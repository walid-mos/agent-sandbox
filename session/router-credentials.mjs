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
  keys: (value, provider) => {
    if (!magpie(['provider', 'keys', provider]).split(/\r?\n/u).includes(value)) magpie(['provider', 'keys', provider, 'add', '-'], value);
  },
  accounts: (value, provider) => { magpie(['accounts', 'import', provider, '/dev/stdin', '--yes'], value); },
};

function credentialsFor() {
  const configured = new Set(Object.entries(sandbox.secrets).concat(Object.entries(sandbox.onRequest?.claude ?? {}))
    .flatMap(([path, names]) => names.map(name => `${path}/${name}`)));
  return CREDENTIALS.filter(entry => entry.input === 'file' || configured.has(`${entry.path}/${entry.name}`));
}

// Node gives a child a socket as stdin, which `open('/dev/stdin')` refuses, so `cat` hands Magpie a pipe.
function magpie(arguments_, input = '') {
  const { status, stdout } = spawnSync('/bin/sh', ['-c', 'cat | "$@"', 'router-credentials', 'magpie', ...arguments_], {
    input, encoding: 'utf8', env: basicEnvironment(process.env, RUNTIME_SETTINGS), stdio: ['pipe', 'pipe', 'ignore'], timeout: COMMAND_SECONDS * 1000,
  });
  if (status !== 0) {
    throw new Error(`router-credentials: magpie ${arguments_.slice(0, 3).join(' ')} failed (exit ${status}). Check the vault credential and seed the router if its providers are missing.`);
  }
  return stdout;
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
  process.stdout.write(`${JSON.stringify(report)}\n`);
});
