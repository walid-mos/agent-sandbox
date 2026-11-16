import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { basicEnvironment, RUNTIME_SETTINGS } from './environment.mjs';
import { main, runOperation } from './main.mjs';
import { CODEX_HOME, MIN_VALIDITY_MS } from './router-codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const SYNC_TIMEOUT_MS = 3 * 60 * 1000;

async function synchronize() {
  const worker = spawn(process.execPath, [join(HERE, 'router-credentials.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'], timeout: SYNC_TIMEOUT_MS,
  });
  let report = '';
  worker.stdout.setEncoding('utf8').on('data', chunk => { report += chunk; });
  const [status] = await once(worker, 'close');
  if (status !== 0) throw new Error('router: vault credential sync failed. Check credentials and seed the router if its providers are missing.');
  let expires;
  try { ({ expires } = JSON.parse(report)); } catch {}
  if (!Number.isFinite(expires)) throw new Error('router: credential sync returned no publication expiry.');
  process.stdout.write(`router: vault credentials synced, publication expires ${new Date(expires).toISOString()}\n`);
  return Math.max(RETRY_MS, Math.min(SYNC_INTERVAL_MS, expires - Date.now() - MIN_VALIDITY_MS));
}

const retrySync = () => synchronize().catch(error => {
  process.stderr.write(`${error.message}\n`);
  return RETRY_MS;
});

async function refreshUntilExit(gateway) {
  const exited = once(gateway, 'exit').then(([status]) => status ?? 1);
  for (let delay = 0; ; delay = await retrySync()) {
    const status = await Promise.race([exited, pause(delay, undefined, { ref: false })]);
    if (status !== undefined) return status;
  }
}

async function serve([address]) {
  if (!address) throw new Error('router: expected the address to listen on, which session/router passes.');
  const env = { ...basicEnvironment(process.env, RUNTIME_SETTINGS), MAGPIE_ADDR: address, DISABLE_AUTOUPDATER: '1', CODEX_HOME };
  const gateway = spawn('magpie', ['serve'], { env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => gateway.kill(signal));
  process.exitCode = await refreshUntilExit(gateway);
}

main(import.meta, () => runOperation({ serve, sync: synchronize }, 'usage: router serve ADDRESS | router sync'));
