import { chownSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIALOG_ID } from '../session/human-contract.mjs';
import { DELEGATIONS_HOME, MIN_EXECUTION_ID, MODEL_KEYS, RUNS_HOME, RUNTIME_HOME, SYSTEM_PATH, TASK_KEYS, below, executionScope } from './launch-execution-contract.mjs';
import { protectedPath, readSecret } from './launch-protection.mjs';

export function runPaths(id) {
  if (!DIALOG_ID.test(id)) throw new Error('mac-launch: invalid execution ID.');
  return { root: join(RUNS_HOME, id), home: join(RUNS_HOME, id, 'home'), session: join(RUNS_HOME, id, 'home/session.jsonl') };
}
const quote = value => JSON.stringify(value);
const subpath = value => `(subpath ${quote(value)})`;
const literal = value => `(literal ${quote(value)})`;

export function sandboxProfile(settings, run, acts) {
  const scope = executionScope(settings, acts);
  const reads = ['/System/Library', '/usr/lib', '/usr/share', '/bin', '/usr/bin', RUNTIME_HOME, settings.directory, run.home].map(subpath);
  const devices = ['/dev/null', '/dev/urandom', '/dev/random', '/dev/tty'].map(literal);
  const configuration = ['/private/etc/hosts', '/private/etc/resolv.conf', '/private/var/run/resolv.conf', '/private/etc/localtime'].map(literal);
  const endpoints = scope.network.map(endpoint => `(remote ip ${quote(`${endpoint.address}:${endpoint.port}`)})`);
  return ['(version 1)', '(deny default)', '(allow process-fork)', '(allow signal (target self))', '(allow sysctl-read)',
    '(allow file-read-metadata)', `(allow file-read* ${[...reads, ...devices, ...configuration].join(' ')})`,
    `(allow file-write* ${subpath(settings.directory)} ${subpath(run.home)} ${literal('/dev/null')} ${literal('/dev/tty')})`,
    `(allow process-exec ${subpath(RUNTIME_HOME)} ${subpath('/bin')} ${subpath('/usr/bin')})`,
    '(allow mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.system.logger") (global-name "com.apple.logd"))',
    ...(endpoints.length ? [`(allow network-outbound ${endpoints.join(' ')})`] : [])].join('\n');
}

function requireDelegationPath(path) {
  if (!below(DELEGATIONS_HOME, path)) throw new Error('mac-launch: a delegation must come from the dedicated delegation directory.');
}

function readDelegation(path) {
  try { return JSON.parse(readSecret(path)); }
  catch { throw new Error('mac-launch: delegation must be private valid JSON. No credential value was disclosed.'); }
}

function requireCredentialObject(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || !Object.keys(credentials).length) {
    throw new Error('mac-launch: delegation contains an unsupported environment key or empty value.');
  }
}

function requireAllowedCredentialValues(credentials, allowed) {
  const hasUnsupportedEntry = Object.entries(credentials).some(([key, value]) => !allowed.includes(key)
    || typeof value !== 'string' || !value || value.includes('\0'));
  if (hasUnsupportedEntry) throw new Error('mac-launch: delegation contains an unsupported environment key or empty value.');
}

function credentialEnvironment(path, allowed) {
  requireDelegationPath(path);
  const credentials = readDelegation(path);
  requireCredentialObject(credentials);
  requireAllowedCredentialValues(credentials, allowed);
  return credentials;
}

export function executionEnvironment(settings, run, acts) {
  const scope = executionScope(settings, acts);
  const modelKey = MODEL_KEYS[settings.execution.model.provider];
  const model = credentialEnvironment(settings.execution.model.credential, [modelKey]);
  const grants = scope.grants.filter(grant => grant.credential).map(grant => credentialEnvironment(grant.credential, TASK_KEYS));
  const pairs = grants.flatMap(grant => Object.keys(grant));
  if (new Set(pairs).size !== pairs.length) throw new Error('mac-launch: two capabilities delegate the same environment key.');
  return { HOME: run.home, XDG_CONFIG_HOME: join(run.home, '.config'), XDG_DATA_HOME: join(run.home, '.local/share'),
    XDG_STATE_HOME: join(run.home, '.local/state'), XDG_CACHE_HOME: join(run.home, '.cache'), TMPDIR: join(run.home, 'tmp'),
    PI_CODING_AGENT_DIR: join(run.home, '.pi/agent'), PATH: `${join(RUNTIME_HOME, 'bin')}:${SYSTEM_PATH}`, SHELL: '/bin/sh',
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', ...model, ...Object.assign({}, ...grants) };
}

const RUN_HOME_FOLDERS = ['tmp', '.ssh', '.pi', '.pi/agent', '.config', '.local', '.local/share', '.local/state', '.cache'];

function createRunHome(run) {
  mkdirSync(run.home, { mode: 0o700 });
  const owned = [run.home];
  for (const folder of RUN_HOME_FOLDERS) {
    const path = join(run.home, folder);
    mkdirSync(path, { mode: 0o700 });
    owned.push(path);
  }
  const preferences = join(run.home, '.pi/agent/settings.json');
  writeFileSync(preferences, JSON.stringify({ defaultProjectTrust: 'never', shellPath: '/bin/sh' }), { flag: 'wx', mode: 0o600 });
  owned.push(preferences);
  return owned;
}

function stageDelegatedFiles(settings, run, acts, owned) {
  const files = executionScope(settings, acts).grants.flatMap(grant => grant.files);
  if (new Set(files.map(file => file.destination)).size !== files.length) throw new Error('mac-launch: two capabilities delegate the same file.');
  for (const file of files) {
    const contents = readSecret(file.source);
    const destination = join(run.home, file.destination);
    writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 });
    owned.push(destination);
  }
}

function assignRunOwnership(paths, execution) {
  for (const path of paths.toReversed()) chownSync(path, execution.uid, execution.gid);
}

export function prepareRun(settings, id, acts) {
  const run = runPaths(id);
  protectedPath(RUNS_HOME);
  mkdirSync(run.root, { mode: 0o755 });
  writeFileSync(join(run.root, '.owner'), id, { flag: 'wx', mode: 0o600, flush: true });
  const owned = createRunHome(run);
  stageDelegatedFiles(settings, run, acts, owned);
  assignRunOwnership(owned, settings.execution);
  chmodSync(run.root, 0o755);
  return run;
}

function requireRootTransition(execution) {
  if (process.getuid() !== 0 || process.geteuid() !== 0 || execution.uid < MIN_EXECUTION_ID || execution.gid < MIN_EXECUTION_ID) {
    throw new Error('mac-launch: only root may enter the separate execution identity.');
  }
}

function requireExecutionTransition(execution) {
  const hasOtherGroup = process.getgroups().some(gid => gid !== execution.gid);
  const hasExactIdentity = process.getuid() === execution.uid && process.geteuid() === execution.uid
    && process.getgid() === execution.gid && !hasOtherGroup;
  if (!hasExactIdentity) throw new Error('mac-launch: execution identity transition failed. No child may start.');
}

export function dropExecutionIdentity(execution) {
  requireRootTransition(execution);
  process.setgroups([]);
  process.setgid(execution.gid);
  process.setuid(execution.uid);
  requireExecutionTransition(execution);
}
