import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../session/run.mjs';
import { herdrRunner } from '../mac/launch-runner.mjs';

const worktree = createHash('sha256').update(fileURLToPath(new URL('..', import.meta.url))).digest('hex').slice(0, 12);
const ownership = join(tmpdir(), `mac-launch-runner-${process.getuid()}-${worktree}.json`);
const launch = randomBytes(16).toString('hex');
const folder = join(tmpdir(), `mac-launch-runner-${launch}`);
const resource = { launch, folder, pid: process.pid, isCoreRequested: false };
const marker = owned => join(owned.folder, '.owner');
const socket = owned => join(owned.folder, 'herdr.sock');
const environment = owned => ({ HOME: owned.folder, XDG_CONFIG_HOME: join(owned.folder, 'config'), XDG_DATA_HOME: join(owned.folder, 'data'),
  XDG_STATE_HOME: join(owned.folder, 'state'), XDG_CACHE_HOME: join(owned.folder, 'cache'), PATH: process.env.PATH,
  HC_SESSION: `mac-launch-probe-${owned.launch}`, HC_SOCKET: socket(owned), SHELL: '/bin/sh', TERM: 'xterm-256color' });
const hc = (owned, args) => command('hc', args, { env: environment(owned), timeout: 25_000 });
const save = () => writeFileSync(ownership, JSON.stringify(resource), { mode: 0o600 });

function cleanup(owned) {
  if (existsSync(owned.folder)) {
    assert.equal(readFileSync(marker(owned), 'utf8'), owned.launch);
    assert.equal(lstatSync(owned.folder).uid, process.getuid());
    if (owned.run) {
      const terminal = JSON.parse(hc(owned, ['get', '--json', owned.run.name]));
      assert.equal(terminal.created_ms, owned.run.createdMs);
      assert.equal(terminal.labels['mac-launch.id'], owned.launch);
      hc(owned, ['kill', owned.run.name]);
      hc(owned, ['rm', owned.run.name]);
    }
    if (owned.isCoreRequested) {
      assert.equal(lstatSync(socket(owned)).isSocket(), true);
      assert.equal(lstatSync(socket(owned)).uid, process.getuid());
      hc(owned, ['server', 'stop']);
    }
    rmSync(owned.folder, { recursive: true });
  }
  if (existsSync(ownership) && JSON.parse(readFileSync(ownership, 'utf8')).launch === owned.launch) rmSync(ownership);
}

if (existsSync(ownership)) {
  const previous = JSON.parse(readFileSync(ownership, 'utf8'));
  let isAlive = true;
  try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') isAlive = false; else throw error; }
  if (isAlive) throw new Error('Another runner proof still owns this worktree context.');
  cleanup(previous);
}
let isOwned = false;
const release = () => { if (isOwned) { cleanup(resource); isOwned = false; } };
process.once('exit', release);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
writeFileSync(ownership, JSON.stringify(resource), { mode: 0o600, flag: 'wx' });
isOwned = true;
try {
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(marker(resource), launch, { flag: 'wx' });
  resource.isCoreRequested = true;
  save();
  hc(resource, ['server', 'start']);
  assert.equal(lstatSync(socket(resource)).isSocket(), true);
  const fixture = fileURLToPath(new URL('./fixtures/mac-launch-pi.mjs', import.meta.url));
  const runner = herdrRunner({ binary: 'hc', env: environment(resource), directory: folder, program: [process.execPath, fixture],
    owner: process.getuid(), session: id => join(folder, `${id}.session.jsonl`) });
  const closed = { name: `ml-gone-${launch.slice(0, 16)}`, session: join(folder, 'none.jsonl'), owner: process.getuid(), createdMs: 1 };
  let isResponsive = false;
  setImmediate(() => { isResponsive = true; });
  assert.equal((await runner.result(closed)).status, 'failed');
  assert.equal(isResponsive, true, 'terminal lookup must let the gate answer Discord events');
  const run = await runner.start({ request: { launch }, prompt: 'Reply ready.' });
  resource.run = run;
  save();
  for (let attempt = 0; attempt < 3; attempt++) {
    const waited = JSON.parse(hc(resource, ['wait', '--json', '--timeout', '20', run.name]));
    if (waited.ended) break;
  }
  assert.deepEqual(await runner.result(run), { status: 'finished', report: 'ready' });
  for (const [reason, detail] of [['error', 'Provider refused the request.'], ['length', 'Pi ended its turn with length.'], ['stop', 'Pi ended its turn without a final text reply.']]) {
    writeFileSync(run.session, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [], stopReason: reason,
      ...(reason === 'error' ? { errorMessage: detail } : {}) } }) + '\n');
    assert.deepEqual(await runner.result(run), { status: 'failed', detail });
  }
  console.log('Isolated real Herdr start, event-loop progress, final report, error, length limit and empty reply passed. No model or Mac was used.');
} finally { release(); }
