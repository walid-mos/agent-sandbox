import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basicEnvironment } from './environment.mjs';
import { main, runOperation } from './main.mjs';
import { CODEX_HOME, CODEX_PUBLICATION, MIN_VALIDITY_MS } from './router-codex.mjs';
import { WITH_VAULT } from './run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const SYNC_TIMEOUT_MS = 60 * 1000;
const RUNTIME_SETTINGS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'TZ', 'NPM_CONFIG_PREFIX', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];

function routerEnvironment(address) {
  return { ...basicEnvironment(process.env, RUNTIME_SETTINGS), MAGPIE_ADDR: address, DISABLE_AUTOUPDATER: '1', CODEX_HOME };
}

async function syncCodex() {
  const worker = spawn(WITH_VAULT, ['--secret', `${CODEX_PUBLICATION.path}/${CODEX_PUBLICATION.name}`, process.execPath, join(HERE, 'router-codex.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'], timeout: SYNC_TIMEOUT_MS,
  });
  let report = '';
  worker.stdout.setEncoding('utf8').on('data', chunk => { report += chunk; });
  const [status] = await once(worker, 'close');
  if (status !== 0) throw new Error('router: Codex vault sync failed. Check the publication and machine credentials, then run router-seed.');
  let expires;
  try {
    ({ expires } = JSON.parse(report));
  } catch {}
  if (!Number.isFinite(expires)) throw new Error('router: Codex sync returned no expiry.');
  process.stdout.write(`router: Codex vault synced, expires ${new Date(expires).toISOString()}\n`);
  return Math.max(RETRY_MS, Math.min(SYNC_INTERVAL_MS, expires - Date.now() - MIN_VALIDITY_MS));
}

async function serve([address]) {
  if (!address) throw new Error('router: expected the address to listen on, which session/router passes.');
  const firstDelay = await syncCodex();
  const gateway = spawn('magpie', ['serve'], { env: routerEnvironment(address), stdio: 'inherit' });
  let timer;
  let activeSync;
  let isStopped = false;
  const schedule = delay => {
    if (isStopped) return;
    timer = setTimeout(() => {
      activeSync = syncCodex().catch(error => {
        process.stderr.write(`${error.message}\n`);
        return RETRY_MS;
      }).then(schedule);
    }, delay);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => gateway.kill(signal));
  schedule(firstDelay);
  let status;
  try {
    [status] = await once(gateway, 'exit');
  } finally {
    isStopped = true;
    clearTimeout(timer);
    await activeSync;
  }
  process.exitCode = status ?? 1;
}

const OPERATIONS = { serve, sync: syncCodex };
const USAGE = 'usage: router serve ADDRESS | router sync';

main(import.meta, () => runOperation(OPERATIONS, USAGE));
