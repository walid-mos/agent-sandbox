import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { isAct } from '../session/launch-contract.mjs';

export const GATE_HOME = '/Library/AgentSandbox/MacLaunch';
export const CODE_HOME = join(GATE_HOME, 'code');
export const EXECUTION_HOME = '/Library/AgentSandbox/Execution';
export const RUNTIME_HOME = '/Library/AgentSandbox/Runtime';
export const DELEGATIONS_HOME = '/Library/AgentSandbox/Delegations';
export const RUNS_HOME = join(EXECUTION_HOME, 'runs');
export const MIN_EXECUTION_ID = 501;
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const MODEL_KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' };
export const TASK_KEYS = ['BOAT_API_KEY', 'BOAT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];
export const FORBIDDEN_ACTS = ['sign-tip', 'launch-gate', 'vm-up', 'restart-pot', 'credentials'];
const SAFE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export const below = (root, path) => typeof path === 'string' && isAbsolute(path) && path === normalize(path) && !/[\x00-\x1f\x7f]/.test(path) && relative(root, path) !== '' && !relative(root, path).startsWith('..') && !isAbsolute(relative(root, path));

function networkAllowed(network) {
  return Array.isArray(network) && network.every(endpoint => isIP(endpoint.address) === 4
    && !/^(0|127|169\.254|22[4-9]|23\d|24\d|25[0-5])\./.test(endpoint.address)
    && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535);
}

function checkedGrant(grant) {
  const hasActs = Array.isArray(grant.acts) && grant.acts.length > 0 && grant.acts.every(act => isAct(act) && !FORBIDDEN_ACTS.includes(act));
  const hasFiles = Array.isArray(grant.files) && grant.files.every(file => below(DELEGATIONS_HOME, file.source)
    && ['.ssh/config', '.ssh/id_ed25519', '.ssh/known_hosts'].includes(file.destination));
  if (!SAFE_NAME.test(grant.name) || !hasActs || !hasFiles || !networkAllowed(grant.network)
    || (grant.credential !== undefined && !below(DELEGATIONS_HOME, grant.credential))) throw new Error('mac-launch: invalid delegated capability. Only scoped spend/publish credentials and selected SSH files are supported.');
}

function checkIdentity(execution) {
  if (!execution || !Number.isSafeInteger(execution.uid) || !Number.isSafeInteger(execution.gid) || execution.uid < MIN_EXECUTION_ID || execution.gid < MIN_EXECUTION_ID
    || !/^_maclaunch[a-z0-9-]*$/.test(execution.user ?? '')) throw new Error('mac-launch: a separate restricted execution account is required.');
}

function hasModelDelegation(model) {
  return model && model.resolver === 'system-dns' && Object.hasOwn(MODEL_KEYS, model.provider) && typeof model.name === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(model.name)
    && below(DELEGATIONS_HOME, model.credential) && networkAllowed(model.network) && model.network.length > 0;
}

export function checkedExecution(settings) {
  const execution = settings.execution;
  checkIdentity(execution);
  const hasTools = ['node', 'pi', 'hc'].every(key => below(RUNTIME_HOME, settings.tools?.[key]));
  if (!hasTools || !below(join(EXECUTION_HOME, 'work'), settings.directory) || !hasModelDelegation(execution.model) || !Array.isArray(execution.grants)) throw new Error('mac-launch: restricted execution needs protected tools, selected work and an explicit dedicated model delegation.');
  execution.grants.forEach(checkedGrant);
  if (new Set(execution.grants.map(grant => grant.name)).size !== execution.grants.length) throw new Error('mac-launch: capability names must be unique.');
  return execution;
}

export function executionScope(settings, acts) {
  const execution = checkedExecution(settings);
  const grants = execution.grants.filter(grant => grant.acts.every(act => acts.includes(act)));
  const missing = acts.filter(act => FORBIDDEN_ACTS.includes(act) || !grants.some(grant => grant.acts.includes(act)));
  if (missing.length) throw new Error(`mac-launch: no safe delegated capability for ${missing.join(', ')}. Run that work manually. No operator authority is inherited.`);
  return { grants, names: ['model', 'system-dns', ...grants.map(grant => grant.name)], network: [...execution.model.network, ...grants.flatMap(grant => grant.network)] };
}

export function executionFingerprint(settings) {
  checkedExecution(settings);
  return createHash('sha256').update(JSON.stringify({ directory: settings.directory, tools: settings.tools, execution: settings.execution })).digest('hex');
}

export function gateEnvironment() {
  return { HOME: GATE_HOME, XDG_CONFIG_HOME: join(GATE_HOME, 'config'), XDG_DATA_HOME: join(GATE_HOME, 'data'),
    XDG_STATE_HOME: join(GATE_HOME, 'state'), XDG_CACHE_HOME: join(GATE_HOME, 'cache'), TMPDIR: join(GATE_HOME, 'tmp'),
    HC_SESSION: 'mac-launch-gate', HC_SOCKET: join(GATE_HOME, 'herdr.sock'), PATH: SYSTEM_PATH, SHELL: '/bin/sh', LANG: 'en_US.UTF-8' };
}
