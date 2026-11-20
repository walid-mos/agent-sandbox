import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { dropExecutionIdentity, executionEnvironment, prepareRun } from '../../mac/launch-isolation.mjs';
import { CODE_HOME, DELEGATIONS_HOME, GATE_HOME, RUNS_HOME } from '../../mac/launch-execution-contract.mjs';
import { protectedPath, readBounded } from '../../mac/launch-protection.mjs';
import { gateStore } from '../../mac/launch-store.mjs';
import { settings } from './mac-launch.mjs';

const AUTHORITY = join(GATE_HOME, 'authority');
const SOCKET = join(GATE_HOME, 'herdr.sock');
const OPERATOR = '/Library/AgentSandbox/Operator';
const OPERATOR_FILES = ['.ssh/id_ed25519', '.pi/agent/auth.json', '.config/infisical/login.json'];
const id = 'b'.repeat(32);
const config = structuredClone(settings);
const denied = operation => assert.throws(operation, error => ['EACCES', 'EPERM'].includes(error.code));

async function attack() {
  process.setgroups([0, 1]);
  dropExecutionIdentity(config.execution);
  assert.equal(process.getuid(), config.execution.uid);
  assert.equal(process.geteuid(), config.execution.uid);
  assert.deepEqual(process.getgroups(), [config.execution.gid]);
  denied(() => process.setuid(0));
  denied(() => process.setgroups([0]));
  for (const file of OPERATOR_FILES) denied(() => readFileSync(join(OPERATOR, file)));
  denied(() => readFileSync(AUTHORITY));
  denied(() => writeFileSync(AUTHORITY, 'forged'));
  denied(() => readFileSync(join(CODE_HOME, 'entry.mjs')));
  denied(() => writeFileSync(join(CODE_HOME, 'entry.mjs'), 'forged'));
  denied(() => readFileSync(config.execution.model.credential));
  await new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET);
    socket.on('connect', () => { socket.destroy(); reject(new Error('execution reached protected Herdr')); });
    socket.on('error', error => { if (['EACCES', 'EPERM'].includes(error.code)) resolve(); else reject(error); });
  });
  const wrapper = spawn(process.execPath, ['/source/mac/launch-pi.mjs', id], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  let failure = '';
  wrapper.stderr.on('data', chunk => { failure += chunk; });
  await new Promise(resolve => wrapper.on('close', code => { assert.equal(code, 1); resolve(); }));
  assert.match(failure, /only the protected root gate/);
  const run = join(RUNS_HOME, id, 'home');
  writeFileSync(join(config.directory, 'work-proof'), 'selected-work', { flag: 'wx' });
  writeFileSync(join(run, 'reply.jsonl'), 'report-only', { flag: 'wx' });
  symlinkSync(AUTHORITY, join(run, 'symlink-report'));
  writeFileSync(join(run, 'large-report'), Buffer.alloc(1024 * 1024 + 1));
  process.stdout.write('Malicious execution UID could not regain root, edit/read authority or code, steal delegation, reach protected Herdr, or invoke the launch wrapper.\n');
}

function setup() {
  for (const folder of [GATE_HOME, CODE_HOME, DELEGATIONS_HOME, RUNS_HOME, config.directory]) mkdirSync(folder, { recursive: true, mode: 0o755 });
  chmodSync(GATE_HOME, 0o700);
  chmodSync(DELEGATIONS_HOME, 0o700);
  chmodSync(config.directory, 0o700);
  chownSync(config.directory, config.execution.uid, config.execution.gid);
  writeFileSync(AUTHORITY, 'fixture-authority', { mode: 0o600 });
  writeFileSync(join(CODE_HOME, 'entry.mjs'), 'protected code', { mode: 0o600 });
  writeFileSync(config.execution.model.credential, JSON.stringify({ OPENAI_API_KEY: 'fixture-only' }), { mode: 0o600 });
  protectedPath(AUTHORITY);
  chmodSync(AUTHORITY, 0o622);
  assert.throws(() => protectedPath(AUTHORITY), /root-owned/);
  chmodSync(AUTHORITY, 0o600);
  const store = gateStore(join(GATE_HOME, 'launches'));
  store.beginExecution(id);
  assert.throws(() => store.beginExecution(id), { code: 'EEXIST' });
  for (const file of OPERATOR_FILES) {
    const path = join(OPERATOR, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'operator-fixture-only', { mode: 0o600 });
    chownSync(path, 65002, 65002);
  }
  chmodSync(OPERATOR, 0o700);
  chownSync(OPERATOR, 65002, 65002);
  const run = prepareRun(config, id, []);
  process.env.SSH_AUTH_SOCK = SOCKET;
  process.env.HC_SOCKET = SOCKET;
  process.env.NODE_OPTIONS = '--require=/poisoned-loader';
  process.env.BASH_ENV = '/poisoned-shell';
  writeFileSync(config.execution.model.credential, JSON.stringify({ OPENAI_API_KEY: 'fixture-only', NODE_OPTIONS: '--require=/poisoned-loader' }));
  assert.throws(() => executionEnvironment(config, run, []), /unsupported environment/);
  writeFileSync(config.execution.model.credential, JSON.stringify({ OPENAI_API_KEY: 'fixture-only' }));
  const env = executionEnvironment(config, run, []);
  for (const key of ['SSH_AUTH_SOCK', 'HC_SOCKET', 'NODE_OPTIONS', 'BASH_ENV']) assert.equal(env[key], undefined);
  assert.equal(env.HOME, run.home);
  assert.equal(env.OPENAI_API_KEY, 'fixture-only');
  return { run, env };
}

if (process.argv[2] === 'attack') await attack();
else {
  const { run, env } = setup();
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  try {
    await new Promise((resolve, reject) => { server.on('error', reject); server.listen(SOCKET, resolve); });
    const child = spawn(process.execPath, [process.argv[1], 'attack'], { env, stdio: 'inherit' });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0);
    assert.equal(connections, 0);
    assert.equal(readFileSync(AUTHORITY, 'utf8'), 'fixture-authority');
    assert.equal(readBounded(join(run.home, 'reply.jsonl'), config.execution.uid), 'report-only');
    assert.throws(() => readBounded(join(run.home, 'symlink-report'), config.execution.uid), { code: 'ELOOP' });
    assert.throws(() => readBounded(join(run.home, 'large-report'), config.execution.uid), /bounded regular file/);
    assert.equal(readFileSync(join(config.directory, 'work-proof'), 'utf8'), 'selected-work');
    process.stdout.write('Exact work/report handoff, exclusive execution marker, environment clearing, symlink refusal and report limit passed. Linux UID proof only.\n');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
