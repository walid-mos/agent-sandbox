import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../session/main.mjs';
import { writePrivateJson } from '../session/private-json.mjs';
import { GATE_HOME, gateEnvironment } from './launch-execution-contract.mjs';
import { dropExecutionIdentity, executionEnvironment, prepareRun, runPaths, sandboxProfile } from './launch-isolation.mjs';
import { loadSettings } from './launch-settings.mjs';
import { protectedPath } from './launch-protection.mjs';
import { readPrivate } from './launch-store.mjs';

const RECORD = join(GATE_HOME, 'native-proof.json');
const ATTACK = `
const fs = require('node:fs');
const cp = require('node:child_process');
const p = JSON.parse(process.argv[1]);
const denied = operation => { try { operation(); return false; } catch (error) { return ['EACCES', 'EPERM'].includes(error.code); } };
const checks = { uid: process.getuid() === p.uid && process.geteuid() === p.uid,
  groups: process.getgroups().every(gid => gid === p.gid),
  credential: denied(() => fs.readFileSync(p.authority)), state: denied(() => fs.writeFileSync(p.authority, 'forged')),
  privilege: denied(() => process.setuid(0)) && denied(() => process.setgroups([0])) && cp.spawnSync('/usr/bin/sudo', ['-n', 'true'], { stdio: 'ignore' }).status !== 0,
  keychain: cp.spawnSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { stdio: 'ignore' }).status !== 0 };
const proof = p.home + '/work-proof';
fs.writeFileSync(proof, 'selected-work', { flag: 'wx' });
checks.scratch = fs.readFileSync(proof, 'utf8') === 'selected-work';
checks.workspace = fs.statSync(process.cwd()).isDirectory();
const failed = Object.keys(checks).filter(key => !checks[key]);
process.stdout.write(failed.length ? 'native-isolation-failed: ' + failed.join(', ') : 'native-isolation-ok');
if (failed.length) process.exitCode = 1;
`;

function started(pid) {
  try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', `${pid}`], { encoding: 'utf8' }).trim(); }
  catch { return undefined; }
}

function cleanup(owner) {
  const run = runPaths(owner.id);
  if (owner.child?.started && Number.isInteger(owner.child.pid) && started(owner.child.pid) === owner.child.started) process.kill(-owner.child.pid, 'SIGKILL');
  if (existsSync(run.root)) {
    protectedPath(run.root);
    if (readFileSync(join(run.root, '.owner'), 'utf8') !== owner.id) throw new Error('mac-launch: native proof ownership changed.');
    rmSync(run.root, { recursive: true });
  }
  const authority = join(GATE_HOME, `${owner.id}.native`);
  if (existsSync(authority) && readFileSync(authority, 'utf8') === owner.id) rmSync(authority);
  if (existsSync(RECORD) && readPrivate(RECORD).id === owner.id) rmSync(RECORD);
}

function child(settings, id) {
  const run = runPaths(id);
  const profile = sandboxProfile(settings, run, []);
  const delegated = executionEnvironment(settings, run, []);
  const env = Object.fromEntries(Object.entries(delegated).filter(([key]) => !key.endsWith('_API_KEY')));
  const parameters = JSON.stringify({ uid: settings.execution.uid, gid: settings.execution.gid, authority: join(GATE_HOME, `${id}.native`), home: run.home });
  dropExecutionIdentity(settings.execution);
  process.chdir(settings.directory);
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, settings.tools.node, '-e', ATTACK, parameters], { env, stdio: 'inherit', timeout: 10_000 });
  process.exitCode = result.status === 0 ? 0 : 1;
}

async function prove(settings) {
  if (existsSync(RECORD)) {
    const previous = readPrivate(RECORD);
    if (started(previous.pid) === previous.started) throw new Error('mac-launch: a native proof is still running.');
    cleanup(previous);
  }
  const owner = { id: randomBytes(16).toString('hex'), pid: process.pid, started: started(process.pid) };
  if (!owner.started) throw new Error('mac-launch: native proof process identity is unavailable.');
  let isOwned = true;
  const release = () => { if (isOwned) { cleanup(owner); isOwned = false; } };
  process.once('exit', release);
  const interrupt = () => process.exit(130);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    writePrivateJson(RECORD, owner);
    writeFileSync(join(GATE_HOME, `${owner.id}.native`), owner.id, { flag: 'wx', mode: 0o600 });
    prepareRun(settings, owner.id, []);
    const process_ = spawn(settings.tools.node, [fileURLToPath(import.meta.url), 'child', owner.id], { env: gateEnvironment(), stdio: 'inherit', detached: true, timeout: 12_000, killSignal: 'SIGKILL' });
    if (process_.pid) owner.child = { pid: process_.pid, started: started(process_.pid) };
    writePrivateJson(RECORD, owner);
    const code = await new Promise((resolve, reject) => { process_.once('error', reject); process_.once('close', resolve); });
    process.exitCode = code === 0 ? 0 : 1;
  } finally {
    release();
    process.removeListener('exit', release);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

main(import.meta, async () => {
  const settings = loadSettings();
  const [operation, id, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('mac-launch: native proof accepts no command.');
  if (operation === 'child') { child(settings, id); return; }
  if (operation !== undefined) throw new Error('mac-launch: native proof accepts no command.');
  await prove(settings);
});
