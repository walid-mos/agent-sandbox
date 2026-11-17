import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

function credentialsFor(sandbox) {
  if (!Object.hasOwn(sandbox, 'jira')) return {};
  const group = sandbox.jira;
  if (typeof group !== 'string' || !GROUP.test(group) || !isObject(sandbox.onRequest?.[group])) {
    throw new Error('jira: sandbox.json jira must name an onRequest group. Fix it and run bin/vm-config.');
  }
  const folders = Object.entries(sandbox.onRequest[group]);
  if (!folders.every(([path, names]) => FOLDER.test(path) && Array.isArray(names)
    && names.every(name => typeof name === 'string' && SECRET_NAME.test(name) && !name.startsWith('INFISICAL_')))) {
    throw new Error('jira: the selected onRequest group must map vault folders to lists of secret names without INFISICAL_ names.');
  }
  const entries = folders.flatMap(([path, names]) => names.map(name => ({ path, name })));
  return Object.fromEntries(Object.entries(CREDENTIAL_NAMES).map(([role, name]) => {
    const matches = entries.filter(entry => entry.name === name);
    if (matches.length !== 1) throw new Error(`jira: onRequest.${group} must list ${name} exactly once.`);
    return [role, matches[0]];
  }));
}

function writeAdapter(path, configuration) {
  const directory = mkdtempSync(join(path, '..', '.mcp-adapter-'));
  try {
    const staged = join(directory, 'mcp-adapter.json');
    writeFileSync(staged, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    renameSync(staged, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function configure(piHome, sandboxPath = SANDBOX) {
  if (!piHome) throw new Error('usage: jira.mjs configure PI_HOME [SANDBOX_JSON]');
  const credentials = credentialsFor(readConfiguration(sandboxPath));
  const isEnabled = Object.hasOwn(credentials, 'email');
  const path = join(piHome, 'mcp-adapter.json');
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (status && !status.isFile()) throw new Error(`jira: ${path} must be a regular file. Review it before provisioning.`);
  if (!isEnabled && !status) return;
  const configuration = status ? readConfiguration(path) : {};
  if (configuration.mcpServers !== undefined && !isObject(configuration.mcpServers)) {
    throw new Error(`jira: ${path} mcpServers must be an object. Review it before provisioning.`);
  }
  const servers = { ...configuration.mcpServers };
  if (!isEnabled && !Object.hasOwn(servers, 'jira')) return;
  delete servers.jira;
  if (isEnabled) {
    const command = [process.execPath, fileURLToPath(import.meta.url)].map(shellQuote).join(' ');
    servers.jira = { url: MCP_URL, auth: false, headers: { Authorization: `!${command} authorization` } };
  }
  const desired = { ...configuration, mcpServers: servers };
  if (JSON.stringify(configuration) === JSON.stringify(desired)) return;
  mkdirSync(piHome, { recursive: true });
  writeAdapter(path, desired);
}

async function authorization(sandboxPath = SANDBOX) {
  const credentials = credentialsFor(readConfiguration(sandboxPath));
  if (!Object.hasOwn(credentials, 'email')) throw new Error('jira: sandbox.json selects no Jira onRequest group.');
  const values = Object.fromEntries(await Promise.all(Object.entries(credentials).map(async ([role, { path, name }]) =>
    [role, await readSecret(path, name)])));
  if (!values.email.trim() || !values.token.trim()) throw new Error('jira: the vault returned an empty Atlassian email or API token.');
  process.stdout.write(`Basic ${Buffer.from(`${values.email}:${values.token}`).toString('base64')}\n`);
}

main(import.meta, () => runOperation({
  check: paths => paths.forEach(path => credentialsFor(readConfiguration(path))),
  configure: ([piHome, sandboxPath]) => configure(piHome, sandboxPath),
  authorization: ([sandboxPath]) => authorization(sandboxPath),
}, 'usage: jira.mjs check SANDBOX_JSON... | configure PI_HOME [SANDBOX_JSON] | authorization [SANDBOX_JSON]'));
