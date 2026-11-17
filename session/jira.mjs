import { chmodSync, mkdirSync, lstatSync, readFileSync, renameSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, runOperation } from './main.mjs';
import { readSecret } from './vault.mjs';

const SANDBOX = '/etc/agent-sandbox/sandbox.json';
const CREDENTIAL_NAMES = { email: 'ATLASSIAN_EMAIL', token: 'ATLASSIAN_API_TOKEN' };
const GROUP = /^[a-z][a-z0-9-]*$/u;
const FOLDER = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/u;
const MCP_URL = 'https://mcp.atlassian.com/v2/mcp';
const ADAPTER_MERGE_TRIES = 5;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shellQuote = text => `'${text.replaceAll("'", "'\"'\"'")}'`;

function readConfiguration(path) {
  try {
    const configuration = JSON.parse(readFileSync(path, 'utf8'));
    if (isObject(configuration)) return configuration;
  } catch {
    throw new Error(`jira: cannot read a JSON object from ${path}. Review the file before provisioning.`);
  }
  throw new Error(`jira: ${path} must contain a JSON object.`);
}

function readAdapterFile(path, piHome) {
  rejectedParent(piHome);
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (!status) return undefined;
  if (!status.isFile()) throw new Error(`jira: ${path} must be a regular file. Review it before provisioning.`);
  return readFileSync(path, 'utf8');
}

function rejectedParent(piHome) {
  for (const directory of [piHome, join(piHome, '..')]) {
    if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`jira: ${directory} is a symlink. Review the session home before provisioning.`);
    }
  }
}

function credentialsFor(sandbox) {
  if (!Object.hasOwn(sandbox, 'jira')) return {};
  const group = sandbox.jira;
  if (typeof group !== 'string' || !GROUP.test(group) || !isObject(sandbox.onRequest?.[group])) {
    throw new Error('jira: sandbox.json jira must name an onRequest group. Fix it and run bin/vm-config.');
  }
  const folders = Object.entries(sandbox.onRequest[group]);
  if (!folders.every(([path, names]) => FOLDER.test(path) && !path.includes('..') && Array.isArray(names)
    && names.every(name => typeof name === 'string' && SECRET_NAME.test(name) && !name.startsWith('INFISICAL_')))) {
    throw new Error('jira: the selected onRequest group must map vault folders to lists of secret names without INFISICAL_ names.');
  }
  const entries = folders.flatMap(([path, names]) => names.map(name => ({ path, name })));
  const expected = Object.values(CREDENTIAL_NAMES);
  const required = expected.join(' and ');
  if (entries.length !== expected.length || !expected.every(name => entries.filter(entry => entry.name === name).length === 1)) {
    throw new Error(`jira: onRequest.${group} must list exactly ${required}.`);
  }
  for (const [scope, extra] of outsideEntries(sandbox, group)) {
    if (extra.some(name => expected.includes(name))) {
      throw new Error(`jira: ${scope} holds ${required}. These names belong only under onRequest.${group}.`);
    }
  }
  return Object.fromEntries(Object.entries(CREDENTIAL_NAMES).map(([role, name]) => [role, entries.find(entry => entry.name === name)]));
}

function outsideEntries(sandbox, group) {
  const owners = sandbox.owners ?? {};
  const namesIn = shapes => (Array.isArray(shapes) ? shapes : []).filter(name => typeof name === 'string');
  const foldersIn = folders => (isObject(folders) ? Object.values(folders).flatMap(names => namesIn(names)) : []);
  return [
    ['owners', isObject(owners) ? Object.values(owners).filter(name => typeof name === 'string') : []],
    ...Object.entries(sandbox.secrets ?? {}).map(([path, names]) => [`secrets ${path}`, namesIn(names)]),
    ...Object.entries(sandbox.onRequest ?? {}).filter(([name]) => name !== group).map(([name, folders]) => [`onRequest.${name}`, foldersIn(folders)]),
  ];
}

function mergedAdapter(configuration, jira) {
  if (configuration.mcpServers !== undefined && !isObject(configuration.mcpServers)) throw new Error('jira: mcp-adapter.json mcpServers must be an object. Review the file before provisioning.');
  const servers = { ...configuration.mcpServers };
  if (jira === undefined) delete servers.jira;
  else servers.jira = jira;
  return { ...configuration, mcpServers: servers };
}

function writeAdapter(path, contents, original) {
  const directory = mkdtempSync(join(path, '..', '.mcp-adapter-'));
  try {
    const staged = join(directory, 'mcp-adapter.json');
    writeFileSync(staged, contents, { mode: 0o600 });
    if (original !== undefined && readFileSync(path, 'utf8') !== original) return false;
    renameSync(staged, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return true;
}

function configure(piHome, sandboxPath = SANDBOX) {
  if (!piHome) throw new Error('usage: jira.mjs configure PI_HOME [SANDBOX_JSON]');
  const credentials = credentialsFor(readConfiguration(sandboxPath));
  const path = join(piHome, 'mcp-adapter.json');
  const jira = Object.hasOwn(credentials, 'email') ? {
    url: MCP_URL,
    auth: false,
    headers: { Authorization: `!${[process.execPath, fileURLToPath(import.meta.url)].map(shellQuote).join(' ')} authorization` },
  } : undefined;
  const mergeOnce = () => {
    const attempt = count => {
      const original = readAdapterFile(path, piHome);
      if (original === undefined && jira === undefined) return true;
      const contents = `${JSON.stringify(mergedAdapter(original === undefined ? {} : readConfiguration(path), jira), null, 2)}\n`;
      if (contents === original) {
        if (original !== undefined && (lstatSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
        return true;
      }
      if (readAdapterFile(path, piHome) !== original) return count < ADAPTER_MERGE_TRIES ? attempt(count + 1) : false;
      mkdirSync(piHome, { recursive: true });
      if (writeAdapter(path, contents, original)) return true;
      return count < ADAPTER_MERGE_TRIES - 1 ? attempt(count + 1) : false;
    };
    return attempt(0);
  };
  if (mergeOnce()) return;
  throw new Error(`jira: ${path} kept changing while provisioning merged it. Close the app that writes it and run bin/session-refresh again.`);
}

async function authorization(sandboxPath = SANDBOX) {
  const credentials = credentialsFor(readConfiguration(sandboxPath));
  if (!Object.hasOwn(credentials, 'email')) throw new Error('jira: sandbox.json selects no Jira onRequest group.');
  const values = Object.fromEntries(await Promise.all(Object.entries(credentials).map(async ([role, { path, name }]) =>
    [role, await readSecret(path, name)])));
  if (Object.values(values).some(value => !value.trim() || /[\r\n]/u.test(value))) {
    throw new Error('jira: the vault returned an empty or multiline Atlassian email or API token.');
  }
  process.stdout.write(`Basic ${Buffer.from(`${values.email}:${values.token}`).toString('base64')}\n`);
}

main(import.meta, () => runOperation({
  check: paths => paths.forEach(path => credentialsFor(readConfiguration(path))),
  configure: ([piHome, sandboxPath]) => configure(piHome, sandboxPath),
  authorization: ([sandboxPath]) => authorization(sandboxPath),
}, 'usage: jira.mjs check SANDBOX_JSON... | configure PI_HOME [SANDBOX_JSON] | authorization [SANDBOX_JSON]'));
