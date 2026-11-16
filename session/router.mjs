import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basicEnvironment } from './environment.mjs';
import { main } from './main.mjs';
import { CODEX_HOME, MIN_VALIDITY_MS } from './router-codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const SYNC_TIMEOUT_MS = 60 * 1000;

export async function syncCodex() {
  const worker = spawn(join(HERE, 'with-vault'), ['--with', 'codex', process.execPath, join(HERE, 'router-codex.mjs')], {
    stdio: ['ignore', 'pipe', 'ignore'], timeout: SYNC_TIMEOUT_MS,
  });
  let report = '';
  worker.stdout.setEncoding('utf8').on('data', chunk => { report += chunk; });
  const [status] = await once(worker, 'exit');
  if (status !== 0) throw new Error('router: Codex vault sync failed. Check the publication and machine credentials, then run router-seed.');
  let expires;
  try {
    expires = JSON.parse(report).expires;
  } catch {
    throw new Error('router: Codex sync returned no expiry.');
  }
  if (!Number.isFinite(expires)) throw new Error('router: Codex sync returned no expiry.');
  process.stdout.write(`router: Codex vault synced, expires ${new Date(expires).toISOString()}\n`);
  return Math.max(RETRY_MS, Math.min(SYNC_INTERVAL_MS, expires - Date.now() - MIN_VALIDITY_MS));
}

main(import.meta, async () => {
  const [address] = process.argv.slice(2);
  if (!address) throw new Error('router: expected the address to listen on, which session/router passes.');
  let nextSync = await syncCodex();
  const environment = { ...basicEnvironment(process.env), MAGPIE_ADDR: address, DISABLE_AUTOUPDATER: '1', CODEX_HOME };
  const gateway = spawn('magpie', ['serve'], { env: environment, stdio: 'inherit' });
  let timer;
  let activeSync;
  let isStopped = false;
  const schedule = () => {
    if (isStopped) return;
    timer = setTimeout(() => {
      activeSync = syncCodex().then(delay => { nextSync = delay; }, error => {
        nextSync = RETRY_MS;
        process.stderr.write(`${error.message}\n`);
      }).finally(schedule);
    }, nextSync);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => gateway.kill(signal));
  schedule();
  const [status] = await once(gateway, 'exit');
  isStopped = true;
  clearTimeout(timer);
  await activeSync;
  process.exitCode = status ?? 1;
});
