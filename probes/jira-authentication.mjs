import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const workspace = mkdtempSync(join(tmpdir(), 'jira-'));
const session = join(workspace, "session 'quoted");
const configurationPath = join(workspace, 'sandbox.json');
const home = join(workspace, '.pi', 'agent');
const adapterPath = join(home, 'mcp-adapter.json');
const synthetic = { ATLASSIAN_EMAIL: 'probe@example.invalid', ATLASSIAN_API_TOKEN: 'invented-probe-token' };
const configuration = { jira: 'atlassian', onRequest: { atlassian: { '/tools/atlassian': Object.keys(synthetic) } } };
const unrelated = { timeout: 321, mcpServers: { unrelated: { command: 'keep-me' } } };
const requests = [];
const childTimeoutMs = 10_000;
let values = { ...synthetic };
let replyMode = 'ok';

function answer(request) {
  requests.push(request);
  const value = values[request.name];
  const replies = {
    ok: [[request.name, value]],
    missing: [],
    other: [['UNRELATED_KEY', value]],
    multiple: [[request.name, value], ['UNRELATED_KEY', value]],
  };
  if (replyMode === 'malformed') return 'unreadable-synthetic-marker\n';
  if (replyMode === 'refused') return JSON.stringify({ ok: false, error: 'synthetic refusal' });
  return JSON.stringify({ ok: true, secrets: replies[replyMode] });
}

const broker = createServer(socket => {
  let request = '';
  socket.on('data', chunk => { request += chunk; });
  socket.on('end', () => socket.end(answer(JSON.parse(request))));
});

function invoke(...arguments_) {
  return new Promise(resolveResult => {
    execFile(process.execPath, [join(session, 'jira.mjs'), ...arguments_], { cwd: workspace, timeout: childTimeoutMs }, (error, stdout, stderr) => {
      resolveResult({ status: error?.code ?? 0, stdout, stderr });
    });
  });
}

function save(path, contents) {
  writeFileSync(path, JSON.stringify(contents));
}

function accepted(result, label) {
  assert.equal(result.status, 0, label);
  assert.equal(result.stderr, '', label);
}

function refused(result, label) {
  assert.notEqual(result.status, 0, label);
  assert.equal(result.stdout, '', label);
  for (const marker of [...Object.values(synthetic), 'unreadable-synthetic-marker']) {
    assert.equal(result.stderr.includes(marker), false, `${label} must keep input private`);
  }
}

async function adapterChecks() {
  accepted(await invoke('configure', home), 'configure reads launch.env');
  const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
  assert.deepEqual(adapter.mcpServers.unrelated, unrelated.mcpServers.unrelated);
  assert.equal(adapter.timeout, unrelated.timeout);
  assert.equal(adapter.mcpServers.jira.auth, false);
  assert.equal(adapter.mcpServers.jira.url, 'https://mcp.atlassian.com/v2/mcp');
  const serialized = readFileSync(adapterPath, 'utf8');
  const encoded = Buffer.from('probe@example.invalid:invented-probe-token').toString('base64');
  for (const marker of [...Object.values(synthetic), encoded]) assert.equal(serialized.includes(marker), false, 'no credential in adapter');
  const before = statSync(adapterPath).mtimeMs;
  chmodSync(adapterPath, 0o644);
  accepted(await invoke('configure', home), 'repeat configure repairs permissions');
  assert.equal(statSync(adapterPath).mode & 0o777, 0o600, 'idempotent configure restores private permissions');
  assert.equal(statSync(adapterPath).mtimeMs, before, 'repeat configure avoids rewriting contents');
  const response = await new Promise(resolveResult => {
    execFile('/bin/sh', ['-c', adapter.mcpServers.jira.headers.Authorization.slice(1)], { cwd: workspace, timeout: childTimeoutMs }, (error, stdout, stderr) => {
      resolveResult({ status: error?.code ?? 0, stdout, stderr });
    });
  });
  accepted(response, 'generated header command');
  assert.equal(response.stdout, 'Basic cHJvYmVAZXhhbXBsZS5pbnZhbGlkOmludmVudGVkLXByb2JlLXRva2Vu\n');
  assert.deepEqual(requests.map(request => request.name).sort(), Object.keys(synthetic).sort());
  assert.ok(requests.every(request => request.kind === 'secret' && request.path === '/tools/atlassian'));
}

async function credentialChecks() {
  for (const name of Object.keys(synthetic)) {
    for (const value of ['', ' \t', 'first\nsecond', 'trailing\n', 'trailing\r', 'trailing\r\n']) {
      values = { ...synthetic, [name]: value };
      const result = await invoke('authorization');
      refused(result, `reject invalid ${name}`);
      assert.equal(result.stderr, 'jira: the vault returned an empty or multiline Atlassian email or API token.\n');
    }
  }
  values = { ...synthetic };
  for (const mode of ['missing', 'other', 'multiple', 'malformed', 'refused']) {
    replyMode = mode;
    refused(await invoke('authorization'), `reject ${mode} broker reply`);
  }
  replyMode = 'ok';
}

async function configurationChecks() {
  const invalid = [
    { ...configuration, onRequest: { atlassian: { '/tools/atlassian': [...Object.keys(synthetic), 'GITHUB_TOKEN'] } } },
    { ...configuration, secrets: { '/tools/atlassian': Object.keys(synthetic) } },
    { ...configuration, onRequest: { ...configuration.onRequest, other: { '/other': Object.keys(synthetic) } } },
    { ...configuration, owners: { owner: 'ATLASSIAN_EMAIL' } },
  ];
  for (const selection of invalid) {
    save(configurationPath, selection);
    refused(await invoke('check', configurationPath), 'reject credentials outside the dedicated group');
  }
  save(configurationPath, { onRequest: configuration.onRequest });
  accepted(await invoke('configure', home), 'remove Jira after opt-out');
  assert.deepEqual(JSON.parse(readFileSync(adapterPath, 'utf8')), unrelated);
  save(configurationPath, configuration);
}

async function parentChecks() {
  for (const parent of ['.pi', 'agent']) {
    const root = join(workspace, `symlink-${parent}`);
    const external = join(workspace, `external-${parent}`);
    const pi = join(root, '.pi');
    mkdirSync(root);
    mkdirSync(external);
    if (parent === 'agent') mkdirSync(pi);
    symlinkSync(external, parent === '.pi' ? pi : join(pi, 'agent'));
    refused(await invoke('configure', join(pi, 'agent')), `reject symlinked ${parent}`);
    assert.equal(existsSync(join(external, 'mcp-adapter.json')), false, 'no external adapter written');
    assert.equal(existsSync(join(external, 'agent')), false, 'no external directory created');
  }
}

try {
  mkdirSync(session);
  mkdirSync(home, { recursive: true });
  for (const module of ['jira.mjs', 'main.mjs', 'vault.mjs', 'environment.mjs']) copyFileSync(join(repository, 'session', module), join(session, module));
  writeFileSync(join(session, 'launch.env'), `POTS_VAULT_SOCKET=${join(workspace, 'vault.sock')}\nPOTS_SESSION_CONFIGURATION=${workspace}\n`);
  save(configurationPath, configuration);
  save(adapterPath, unrelated);
  broker.listen(join(workspace, 'vault.sock'));
  await once(broker, 'listening');
  await adapterChecks();
  await credentialChecks();
  await configurationChecks();
  await parentChecks();
  console.log('ok   jira-local-authentication, invalid credentials and replies, dedicated group, private adapter and symlink refusal');
} finally {
  await new Promise(resolveClosed => broker.close(resolveClosed));
  rmSync(workspace, { recursive: true, force: true });
}
