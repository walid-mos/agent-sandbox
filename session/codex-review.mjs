import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_POTS, refuseCodex } from './router-codex-contract.mjs';
import { READ_COMMAND_MS } from './codex-limits.mjs';
export { CODEX_POTS } from './router-codex-contract.mjs';
export { PREFLIGHT_MS } from './codex-limits.mjs';

export const SOURCE_PARENT = '6d71925e5467b58e7a935498c5a271cf5a9c059b';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{40}$/u;
const ORIGIN = 'https://github.com/walid-mos/agent-sandbox.git';

export function boundedCommand(file, arguments_, { deadline = Date.now() + READ_COMMAND_MS, ...options } = {}) {
  if (Date.now() >= deadline) throw refuseCodex('aggregate read-only deadline exhausted');
  try {
    return execFileSync(file, arguments_, { timeout: Math.min(READ_COMMAND_MS, deadline - Date.now()), encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  } catch { throw refuseCodex('bounded command failed. No retry'); }
}

export function checkReviewedSource(source, repository, deadline) {
  if (source.parent !== SOURCE_PARENT || !SHA.test(source.tip ?? '') || !Array.isArray(source.allowedCommits)) throw refuseCodex('new exact source scope missing');
  const git = arguments_ => boundedCommand('git', ['--no-optional-locks', '-C', repository, ...arguments_], { deadline }).trim();
  const configuration = git(['config', '--local', '--no-includes', '--list']);
  if (/^(?:include\.|includeif\.|core\.(?:fsmonitor|hookspath|sshcommand)|filter\.|diff\.external|credential\.|alias\.)/imu.test(configuration)) {
    throw refuseCodex('repository command configuration requires separate inspection');
  }
  if (git(['remote', 'get-url', 'origin']) !== ORIGIN || source.origin !== ORIGIN) throw refuseCodex('origin drift');
  if (git(['rev-parse', 'HEAD']) !== source.tip || git(['branch', '--show-current']) !== source.branch) throw refuseCodex('source tip or branch drift');
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw refuseCodex('dirty source');
  git(['merge-base', '--is-ancestor', source.parent, source.tip]);
  const commits = git(['rev-list', '--reverse', `${source.parent}..${source.tip}`]).split('\n').filter(Boolean);
  if (JSON.stringify(commits) !== JSON.stringify(source.allowedCommits) || commits.length === 0) throw refuseCodex('unreviewed source commit delta');
  return { isExactSource: true };
}

export function verifyResources(scope, repository) {
  const manifestBytes = readFileSync(join(repository, 'resources/codex-targeted-v1/manifest.json'));
  if (sha256(manifestBytes) !== scope.manifestSha256) throw refuseCodex('resource manifest drift');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.contract !== 'CODEX_TARGETED_V1' || manifest.sourceParent !== SOURCE_PARENT) throw refuseCodex('unsupported resource contract');
  for (const [path, expected] of Object.entries(manifest.resources)) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw refuseCodex('invalid resource path');
    if (sha256(readFileSync(join(repository, path))) !== expected.sha256) throw refuseCodex('reviewed resource drift');
  }
}

function requireDirectEndpoints(scope) {
  for (const machine of ['mac', ...CODEX_POTS]) {
    let endpoint;
    try { endpoint = new URL(scope.routerEndpoints?.[machine]); } catch { throw refuseCodex('reviewed loopback router endpoint missing'); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/v1' ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !/^codex\/gpt-6\.2-sol:high(?:#[^\s#]+)?$/u.test(scope.routes?.[machine] ?? '')) throw refuseCodex('unsupported direct route or loopback endpoint');
  }
  if (scope.routes.nextnodeRecovery !== scope.routes.nextnode) throw refuseCodex('recovery route drift');
}

export function reviewAdmission(review, now = Date.now()) {
  const scope = review.scope;
  if (scope?.contract !== 'CODEX_TARGETED_V1' || scope.claude !== 'DEFERRED' || scope.applicationRequests !== 6 ||
      JSON.stringify(scope.pots) !== JSON.stringify(CODEX_POTS) || scope.recoveryPot !== 'nextnode') throw refuseCodex('unsupported execution contract');
  const digest = sha256(JSON.stringify(scope));
  for (const role of ['parentApproval', 'operatorApproval']) {
    const receipt = review[role];
    if (receipt?.state !== 'ACCEPTED' || receipt.scopeSha256 !== digest || !receipt.evidence || !Number.isFinite(Date.parse(receipt.at)) || Date.parse(receipt.at) > now) {
      throw refuseCodex(`${role} for the exact changed contract and window is absent`);
    }
  }
  const { notBefore, admitUntil, recoveryReserveSeconds, minimumStartSeconds } = scope.window ?? {};
  if (!Number.isFinite(Date.parse(notBefore)) || !Number.isFinite(Date.parse(admitUntil)) ||
      !Number.isInteger(recoveryReserveSeconds) || recoveryReserveSeconds < 1800 ||
      !Number.isInteger(minimumStartSeconds) || minimumStartSeconds < recoveryReserveSeconds ||
      now < Date.parse(notBefore) || now + minimumStartSeconds * 1000 > Date.parse(admitUntil)) throw refuseCodex('new explicit admission window is closed or insufficient');
  if (!scope.source?.allowedCommits?.length || !scope.manifestSha256 || !scope.routes) throw refuseCodex('exact source, resources or routes missing');
  requireDirectEndpoints(scope);
  return { scopeSha256: digest, claude: 'DEFERRED' };
}
