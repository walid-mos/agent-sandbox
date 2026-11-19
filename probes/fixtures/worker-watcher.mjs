import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'pots-admission-'));
const previousHome = process.env.HOME;
process.env.HOME = scratch;
const BOT = 'nextnode';
export const RETRY_MS = 5_000;
export const EPOCH = 1_800_000_000_000;
export let hc;
let uuid = 1_000_000;

mock.module('node:crypto', { exports: { createHash, randomBytes, randomUUID: () => `10000000-0000-4000-8000-${String(uuid--).padStart(12, '0')}` } });

function runTerminal(args) {
  const option = name => args[args.indexOf(name) + 1];
  const name = option('--name');
  hc.attempts.push(name);
  if (hc.refuse === name) throw new Error('terminal refused');
  const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
  hc.terminals.push({ name, address: name, cwd: option('--cwd'), labels, state: 'live', status: hc.startStatus });
  return '';
}

function command(binary, [action, ...args]) {
  if (binary === 'pi' && action === '--help') return '';
  if (binary === 'pots' && action === 'wake') return '';
  if (binary !== 'hc') throw new Error(`Unexpected command: ${binary} ${action}`);
  if (action === 'ls' && hc.listError) throw new Error('hc unavailable');
  if (action === 'ls') return JSON.stringify({ terminals: hc.terminals });
  if (action === 'get' && args.length === 1 && hc.missingAddress === args[0]) throw new Error('address unavailable');
  if (action === 'get') return JSON.stringify(hc.terminals.find(terminal => terminal.address === args.at(-1)));
  if (action === 'run') return runTerminal(args);
  if (action === 'send') return hc.messages.push({ terminal: args[1], text: args[2] });
  throw new Error(`Unexpected hc command: ${action}`);
}

mock.module('../../session/sandbox.mjs', { exports: { botId: BOT, sandbox: {} } });
mock.module('../../session/run.mjs', { exports: { command, failureReason: error => error.message, WITH_VAULT: '/unused' } });
const { createWatcher } = await import('../../session/watcher.mjs');
export const { enqueue, queued } = await import('../../session/queue.mjs');
export const { statePath } = await import('../../session/worker-lifecycle.mjs');
const { save, workers, WORKERS } = await import('../../session/workers.mjs');
const { writePrivateJson } = await import('../../session/private-json.mjs');
export { workers, writePrivateJson };

beforeEach(({ mock: { timers } }) => {
  timers.enable({ apis: ['Date', 'setTimeout'], now: EPOCH });
  rmSync(WORKERS, { force: true, recursive: true });
  hc = { terminals: [], attempts: [], messages: [], startStatus: 'working' };
});

after(() => {
  mock.restoreAll();
  process.env.HOME = previousHome;
  rmSync(scratch, { force: true, recursive: true });
});

export function arrange(names) {
  const memory = { total: 8_126_464, available: 2_800_000, swapTotal: 2_097_152, swapFree: 62_915, some: '0.00', full: '0.00' };
  const failures = [];
  const metrics = new Map();
  function readText(path) {
    if (metrics.has(path)) {
      const reading = metrics.get(path);
      const value = typeof reading === 'function' ? reading() : reading;
      if (value instanceof Error) throw value;
      return value;
    }
    if (path === '/proc/meminfo' && memory.error) throw memory.error;
    if (path === '/proc/meminfo') return `MemTotal: ${memory.total} kB\nMemAvailable: ${memory.available} kB\nSwapTotal: ${memory.swapTotal} kB\nSwapFree: ${memory.swapFree} kB\n`;
    if (path === '/proc/self/cgroup') return '';
    if (path !== '/proc/pressure/memory') throw Object.assign(new Error(`No metric file ${path}`), { code: 'ENOENT' });
    if (memory.psiError) throw memory.psiError;
    return `some avg10=${memory.some} avg60=0.00 avg300=0.00 total=100\nfull avg10=${memory.full} avg60=0.00 avg300=0.00 total=5\n`;
  }
  const restart = () => createWatcher({ readText, now: () => Date.now(), logFailure: (subject, error) => failures.push(`${subject}: ${error.message}`) });
  for (const name of names) {
    save({ name, owner: BOT, kind: 'task', worktree: join(scratch, name), brief: '/brief.md' });
    enqueue({ worker: name });
  }
  return { pass: restart(), memory, failures, metrics, restart };
}
