import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const worktree = createHash('sha256').update(repository).digest('hex').slice(0, 12);
const record = join(tmpdir(), `mac-launch-isolation-${process.getuid()}-${worktree}.json`);
const IMAGE = 'node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const owner = randomUUID();
const name = `mac-launch-proof-${worktree}-${owner}`;
const resource = { owner, name, worktree, pid: process.pid };
let isOwned = false;

function inspect(name_) {
  try { return JSON.parse(docker(['inspect', name_]))[0]; }
  catch (error) {
    if (/no such (object|container)/i.test(`${error.stderr}`)) return undefined;
    throw new Error('Mac isolation proof needs a working Docker engine. No fixture cleanup was assumed.');
  }
}

function removeFixture(owned) {
  const container = inspect(owned.name);
  if (container) {
    assert.equal(container.Config.Labels['mac-launch.owner'], owned.owner);
    assert.equal(container.Config.Labels['mac-launch.worktree'], owned.worktree);
    assert.equal(container.HostConfig.NetworkMode, 'none');
    if (owned.id) assert.equal(container.Id, owned.id);
    docker(['rm', '-f', container.Id]);
    assert.equal(inspect(owned.name), undefined);
  }
  if (JSON.parse(readFileSync(record, 'utf8')).owner === owned.owner) rmSync(record);
}

function cleanup() {
  if (!isOwned) return;
  removeFixture(resource);
  isOwned = false;
}

if (existsSync(record)) {
  const previous = JSON.parse(readFileSync(record, 'utf8'));
  let isAlive = true;
  try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') isAlive = false; else throw error; }
  if (isAlive) throw new Error('An isolation proof still owns this worktree fixture.');
  removeFixture(previous);
}
process.once('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
writeFileSync(record, JSON.stringify(resource), { flag: 'wx', mode: 0o600 });
isOwned = true;
try {
  resource.id = docker(['create', '--name', name, '--label', `mac-launch.owner=${owner}`, '--label', `mac-launch.worktree=${worktree}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--tmpfs', '/Library/AgentSandbox:rw,nosuid,nodev,mode=0755',
    '--mount', `type=bind,src=${repository},dst=/source,readonly`, IMAGE, 'node', '/source/probes/fixtures/mac-launch-attacks.mjs']);
  writeFileSync(record, JSON.stringify(resource), { mode: 0o600 });
  const output = docker(['start', '--attach', resource.id]);
  process.stdout.write(`${output}\n`);
  assert.equal(inspect(name).State.ExitCode, 0);
} finally { cleanup(); }
console.log('Owned isolation container and its temporary filesystem were removed. No account or host permission was changed.');
