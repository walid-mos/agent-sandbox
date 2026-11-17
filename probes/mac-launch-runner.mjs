import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../session/run.mjs';
import { herdrRunner } from '../mac/launch-runner.mjs';
import { gateStore } from '../mac/launch-store.mjs';

const launch = randomBytes(16).toString('hex');
const ownership = join(tmpdir(), `mac-launch-runner-${launch}.json`);
const folder = mkdtempSync(join(tmpdir(), 'mac-launch-runner-'));
const marker = join(folder, '.owner');
writeFileSync(marker, launch);
let run;
function cleanup() {
  if (run) {
    const terminal = JSON.parse(command('hc', ['get', '--json', run.name]));
    if (terminal.created_ms !== run.createdMs || terminal.labels['mac-launch.id'] !== launch) throw new Error('Probe no longer owns the terminal.');
    command('hc', ['kill', run.name]);
    command('hc', ['rm', run.name]);
    run = undefined;
  }
  if (existsSync(marker) && readFileSync(marker, 'utf8') === launch) rmSync(folder, { recursive: true });
  rmSync(ownership, { force: true });
}
process.once('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
writeFileSync(ownership, JSON.stringify({ launch, folder }));
try {
  const fixture = fileURLToPath(new URL('./fixtures/mac-launch-pi.mjs', import.meta.url));
  const runner = herdrRunner(gateStore(folder), [process.execPath, fixture]);
  run = runner.start({ request: { launch }, prompt: 'Reply ready.' }, { directory: folder });
  writeFileSync(ownership, JSON.stringify({ launch, folder, ...run }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const waited = JSON.parse(command('hc', ['wait', '--json', '--timeout', '20', run.name], { timeout: 25_000 }));
    if (waited.ended) break;
  }
  assert.deepEqual(runner.result(run), { status: 'finished', report: 'ready' });
  console.log('Real Herdr terminal start and final report passed. No model or Mac was used.');
} finally { cleanup(); }
