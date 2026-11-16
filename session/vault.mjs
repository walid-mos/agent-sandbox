import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basicEnvironment } from './environment.mjs';
import { main } from './main.mjs';

const VAULT_CONFIG = '/etc/agent-sandbox/vault.json';
const GITHUB_PATH = '/tools/github';
const CLIENT_SECRET = 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET';
const USAGE = 'usage: with-vault [--with GROUP | --source REPOSITORY] command [argument...]';
const REQUESTS = { '--with': sandboxRequest, '--source': sourceFetchRequest };

function assignments(text) {
  return Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
}

function infisical(arguments_, env) {
  return execFileSync('infisical', arguments_, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function vaultConfig() {
  if (!existsSync(VAULT_CONFIG)) throw new Error('with-vault: add vault.json, with project and environment, to this sandbox\'s directory under ~/.config/agent-sandbox/sandboxes.');
  const { project, environment } = JSON.parse(readFileSync(VAULT_CONFIG, 'utf8'));
  if (!project || !environment) throw new Error(`with-vault: set project and environment in ${VAULT_CONFIG}.`);
  return { project, environment };
}

function folder(path, env, vault) {
  const output = infisical(['export', '--projectId', vault.project, '--env', vault.environment, '--path', path, '--format', 'json', '--silent'], env);
  // A parse error quotes its input, which holds secret values, so a fixed message replaces it.
  try {
    return new Map(JSON.parse(output).map(secret => [secret.key, secret.value]));
  } catch {
    throw new Error(`with-vault: the vault returned no readable secret list for ${path}`);
  }
}

function listed(path, names, env, vault) {
  const secrets = folder(path, env, vault);
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
  const credentialsFile = process.env.POTS_VAULT_CREDENTIALS;
  const login = { ...process.env, ...(credentialsFile && existsSync(credentialsFile) ? assignments(readFileSync(credentialsFile, 'utf8')) : {}) };
  const session = { ...login, INFISICAL_TOKEN: infisical(['login', '--method=universal-auth', '--silent', '--plain'], login) };
  delete session[CLIENT_SECRET];
  return session;
}

async function sourceFetchRequest(repository) {
  const source = (await import('./agent-sources.mjs')).sourceFor(repository);
  if (!source) throw new Error('with-vault: repository is outside the approved agent sources.');
  return {
    groups: [{ [GITHUB_PATH]: [source.credential] }],
    environment: session => ({ ...basicEnvironment(session), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }),
  };
}

async function sandboxRequest(group) {
  const { sandbox } = await import('./sandbox.mjs');
  return {
    groups: [{ [GITHUB_PATH]: Object.values(sandbox.owners) }, sandbox.secrets, onRequest(group, sandbox)],
    environment: session => session,
  };
}

export function readVault(groups) {
  const vault = vaultConfig();
  const session = vaultSession();
  return { session, secrets: groups.flatMap(Object.entries).flatMap(([path, names]) => listed(path, names, session, vault)) };
}

main(import.meta, async () => {
  const arguments_ = process.argv.slice(2);
  const [request, requestArgument, commandLine] = Object.hasOwn(REQUESTS, arguments_[0]) ?
    [REQUESTS[arguments_[0]], arguments_[1], arguments_.slice(2)] : [sandboxRequest, undefined, arguments_];
  if (commandLine.length === 0) throw new Error(USAGE);
  const { groups, environment } = await request(requestArgument);
  const { session, secrets } = readVault(groups);
  process.execve('/usr/bin/env', ['env', ...commandLine], { ...environment(session), ...Object.fromEntries(secrets) });
});
