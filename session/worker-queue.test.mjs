import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const queueModule = new URL('./queue.mjs', import.meta.url).href;

async function producer(home, worker) {
  const script = `import { enqueue } from ${JSON.stringify(queueModule)}; Date.now = () => 42; enqueue({ worker: process.argv[1] });`;
  await run(process.execPath, ['--input-type=module', '-e', script, worker], { env: { HOME: home, PATH: process.env.PATH }, timeout: 5_000 });
}

async function snapshot(home) {
  const script = `import { queued } from ${JSON.stringify(queueModule)}; console.log(JSON.stringify(queued()));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env: { HOME: home }, timeout: 5_000 });
  return JSON.parse(stdout);
}

test('concurrent producers publish distinct requests that a restarted queue reader sees in sequence', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pots-order-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const queue = join(home, '.config/agent-sandbox/workers/queue');
  mkdirSync(queue, { recursive: true });
  const existing = '1800000000000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json';
  writeFileSync(join(queue, existing), JSON.stringify({ worker: 'before-update', sentTo: 'launch-1' }));
  const names = ['one', 'two', 'three', 'four', 'five', 'six'];
  await Promise.all(names.map(name => producer(home, name)));
  const requests = await snapshot(home);
  assert.deepEqual(requests[0], { worker: 'before-update', sentTo: 'launch-1', file: existing });
  const [, ...published] = requests;
  assert.deepEqual(published.map(({ worker }) => worker).sort(), [...names].sort());
  assert.deepEqual(published.map(({ file }) => Number(file.match(/^q-(\d+)\.json$/)?.[1])), [1, 2, 3, 4, 5, 6]);
  for (const { file } of requests) rmSync(join(queue, file));
  await producer(home, 'later');
  const [later] = await snapshot(home);
  assert.ok(later.file > requests.at(-1).file, 'request IDs are never reused after the queue drains');
});
