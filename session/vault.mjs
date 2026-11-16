import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { main } from './main.mjs';

const VAULT_CONFIG = '/etc/agent-sandbox/vault.json';
if (!existsSync(VAULT_CONFIG)) throw new Error('with-vault: add vault.json, with project and environment, to this sandbox\'s directory under ~/.config/agent-sandbox/sandboxes.');
const { project: VAULT_PROJECT, environment: VAULT_ENV } = JSON.parse(readFileSync(VAULT_CONFIG, 'utf8'));
if (!VAULT_PROJECT || !VAULT_ENV) throw new Error(`with-vault: set project and environment in ${VAULT_CONFIG}.`);
const GITHUB_PATH = '/tools/github';
const CLIENT_SECRET = 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET';
const ON_REQUEST_FLAG = '--with';
const SOURCE_FETCH_ENVIRONMENT = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT'];
const [credentialsFile, ...rest] = process.argv.slice(2);
const isSourceFetch = rest[0] === '--source';
const requestedGroup = rest[0] === ON_REQUEST_FLAG ? rest[1] : undefined;
const commandLine = isSourceFetch ? rest.slice(2) : requestedGroup === undefined ? rest : rest.slice(2);

function assignments(text) {
  return Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
}

function infisical(arguments_, env) {
  return execFileSync('infisical', arguments_, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function folder(path, env) {
  const output = infisical(['export', '--projectId', VAULT_PROJECT, '--env', VAULT_ENV, '--path', path, '--format', 'json', '--silent'], env);
  // A parse error quotes its input, which holds secret values, so a fixed message replaces it.
  try {
    return new Map(JSON.parse(output).map(secret => [secret.key, secret.value]));
  } catch {
    throw new Error(`with-vault: the vault returned no readable secret list for ${path}`);
  }
}

function listed(path, names, env) {
  const secrets = folder(path, env);
  const missing = names.filter(name => typeof secrets.get(name) !== 'string');
  if (missing.length > 0) {
    throw new Error(`with-vault: ${missing.join(', ')} not found in ${path}. Add it to the vault or remove it from the sandbox's list.`);
  }
  return names.map(name => [name, secrets.get(name)]);
}

function onRequest(group, sandbox) {
  if (group === undefined) return {};
  const folders = sandbox.onRequest?.[group];
  if (!folders) throw new Error(`with-vault: the sandbox names no secrets under onRequest.${group}. Add them to its sandbox.json.`);
  return folders;
}

function vaultSession() {
  const login = { ...process.env, ...(existsSync(credentialsFile) ? assignments(readFileSync(credentialsFile, 'utf8')) : {}) };
  const session = { ...login, INFISICAL_TOKEN: infisical(['login', '--method=universal-auth', '--silent', '--plain'], login) };
  delete session[CLIENT_SECRET];
  return session;
}

async function sourceFetchRequest(repository) {
  const source = (await import('./agent-sources.mjs')).sourceFor(repository);
  if (!source) throw new Error('with-vault: repository is outside the approved agent sources.');
  return {
    groups: [{ [GITHUB_PATH]: [source.credential] }],
    environment: session => ({ ...Object.fromEntries(Object.entries(session).filter(([name]) => SOURCE_FETCH_ENVIRONMENT.includes(name))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }),
  };
}

async function sandboxRequest() {
  const { sandbox } = await import('./sandbox.mjs');
  return {
    groups: [{ [GITHUB_PATH]: Object.values(sandbox.owners) }, sandbox.secrets, onRequest(requestedGroup, sandbox)],
    environment: session => session,
  };
}

main(import.meta, async () => {
  if (commandLine.length === 0) throw new Error('usage: with-vault [--with GROUP | --source REPOSITORY] command [argument...]');
  const { groups, environment } = await (isSourceFetch ? sourceFetchRequest(rest[1]) : sandboxRequest());
  const session = vaultSession();
  const secrets = groups.flatMap(Object.entries).flatMap(([path, names]) => listed(path, names, session));
  process.execve('/usr/bin/env', ['env', ...commandLine], { ...environment(session), ...Object.fromEntries(secrets) });
});
