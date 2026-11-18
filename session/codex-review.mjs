import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_CONTRACT, CODEX_POTS, refuseCodex } from './codex-contract-names.mjs';
import { READ_COMMAND_MS } from './codex-limits.mjs';
import { dateMilliseconds, requireArray, requireEqual, requireFields, requireMinimumInteger, requireObject, requirePastDate, requireString } from './codex-validation.mjs';
export { CODEX_POTS } from './codex-contract-names.mjs';
export { PREFLIGHT_MS } from './codex-limits.mjs';

export const SOURCE_PARENT = '6d71925e5467b58e7a935498c5a271cf5a9c059b';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{40}$/u;
const ORIGIN = 'https://github.com/walid-mos/agent-sandbox.git';
const SOURCE_CONFIGURATION = /^(?:include\.|includeif\.|core\.(?:fsmonitor|hookspath|sshcommand)|filter\.|diff\.external|credential\.|alias\.)/imu;
const MINIMUM_RECOVERY_SECONDS = 1800;

export function boundedCommand(file, arguments_, { deadline = Date.now() + READ_COMMAND_MS, ...options } = {}) {
  if (Date.now() >= deadline) throw refuseCodex('aggregate read-only deadline exhausted');
  try {
    return execFileSync(file, arguments_, { timeout: Math.min(READ_COMMAND_MS, deadline - Date.now()), encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  } catch { throw refuseCodex('bounded command failed. No retry'); }
}

function requireSourceScope(source) {
  requireObject(source, 'new exact source scope missing');
  requireEqual(SOURCE_PARENT, source.parent, 'source parent drift');
  requireString(source.tip, 'new exact source tip missing');
  requireEqual(true, SHA.test(source.tip), 'invalid source tip');
  requireArray(source.allowedCommits, 'exact allowed commits missing');
}

export function checkReviewedSource(source, repository, deadline) {
  requireSourceScope(source);
  const git = arguments_ => boundedCommand('git', ['--no-optional-locks', '-C', repository, ...arguments_], { deadline }).trim();
  if (SOURCE_CONFIGURATION.test(git(['config', '--local', '--no-includes', '--list']))) throw refuseCodex('repository command configuration requires separate inspection');
  requireEqual(ORIGIN, git(['remote', 'get-url', 'origin']), 'origin drift');
  requireEqual(ORIGIN, source.origin, 'origin drift');
  requireEqual(source.tip, git(['rev-parse', 'HEAD']), 'source tip drift');
  requireEqual(source.branch, git(['branch', '--show-current']), 'source branch drift');
  requireEqual('', git(['status', '--porcelain', '--untracked-files=all']), 'dirty source');
  git(['merge-base', '--is-ancestor', source.parent, source.tip]);
  const commits = git(['rev-list', '--reverse', `${source.parent}..${source.tip}`]).split('\n').filter(Boolean);
  if (!commits.length) throw refuseCodex('source commit delta is empty');
  requireEqual(commits, source.allowedCommits, 'unreviewed source commit delta');
  return { isExactSource: true };
}

function verifyResource(repository, path, expected) {
  if (path.startsWith('/') || path.split('/').includes('..')) throw refuseCodex('invalid resource path');
  const bytes = readFileSync(join(repository, path));
  requireEqual(expected.sha256, sha256(bytes), 'reviewed resource drift');
  requireEqual(expected.bytes, bytes.length, 'reviewed resource size drift');
}

export function verifyResources(scope, repository) {
  const manifestBytes = readFileSync(join(repository, 'resources/codex-targeted-v1/manifest.json'));
  requireEqual(scope.manifestSha256, sha256(manifestBytes), 'resource manifest drift');
  const manifest = JSON.parse(manifestBytes);
  requireEqual(CODEX_CONTRACT, manifest.contract, 'unsupported resource contract');
  requireEqual(SOURCE_PARENT, manifest.sourceParent, 'resource parent drift');
  for (const [path, expected] of Object.entries(manifest.resources)) verifyResource(repository, path, expected);
}

function requireEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw refuseCodex('reviewed loopback router endpoint missing'); }
  const expected = { protocol: 'http:', hostname: '127.0.0.1', pathname: '/v1', username: '', password: '', search: '', hash: '' };
  requireFields(expected, endpoint, 'unsupported loopback router endpoint');
}

function requireDirectEndpoints(scope) {
  requireObject(scope.routes, 'reviewed direct routes missing');
  requireObject(scope.routerEndpoints, 'reviewed loopback endpoints missing');
  for (const machine of ['mac', ...CODEX_POTS]) {
    requireEndpoint(scope.routerEndpoints[machine]);
    requireEqual(true, /^codex\/gpt-6\.2-sol:high(?:#[^\s#]+)?$/u.test(scope.routes[machine]), 'unsupported direct route');
  }
  requireEqual(scope.routes.nextnode, scope.routes.nextnodeRecovery, 'recovery route drift');
}

function requireContract(scope) {
  requireObject(scope, 'execution contract missing');
  const expected = { contract: CODEX_CONTRACT, claude: 'DEFERRED', applicationRequests: 6, pots: CODEX_POTS, recoveryPot: 'nextnode' };
  requireFields(expected, scope, 'unsupported execution contract');
}

function requireReceipt(receipt, digest, now, role) {
  const reason = `${role} for the exact changed contract and window is absent`;
  requireObject(receipt, reason);
  requireEqual('ACCEPTED', receipt.state, reason);
  requireEqual(digest, receipt.scopeSha256, reason);
  requireString(receipt.evidence, reason);
  requirePastDate(receipt.at, now, reason);
}

function requireWindow(window, now) {
  const reason = 'new explicit admission window is closed or insufficient';
  requireObject(window, reason);
  const notBefore = dateMilliseconds(window.notBefore, reason);
  const admitUntil = dateMilliseconds(window.admitUntil, reason);
  requireMinimumInteger(window.recoveryReserveSeconds, MINIMUM_RECOVERY_SECONDS, reason);
  requireMinimumInteger(window.minimumStartSeconds, window.recoveryReserveSeconds, reason);
  if (now < notBefore || now + window.minimumStartSeconds * 1000 > admitUntil) throw refuseCodex(reason);
}

export function reviewAdmission(review, now = Date.now()) {
  requireContract(review.scope);
  const digest = sha256(JSON.stringify(review.scope));
  for (const role of ['parentApproval', 'operatorApproval']) requireReceipt(review[role], digest, now, role);
  requireWindow(review.scope.window, now);
  requireSourceScope(review.scope.source);
  requireMinimumInteger(review.scope.source.allowedCommits.length, 1, 'exact allowed source commits missing');
  requireString(review.scope.manifestSha256, 'exact resource manifest missing');
  requireDirectEndpoints(review.scope);
  return { scopeSha256: digest, claude: 'DEFERRED' };
}
