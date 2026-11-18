import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { basicEnvironment, RUNTIME_SETTINGS } from './environment.mjs';
import { boundedCommand, checkReviewedSource, CODEX_POTS, PREFLIGHT_MS, reviewAdmission, verifyResources } from './codex-review.mjs';
import { codexPlan, refuseCodex, upgradedSnapshot } from './router-codex-contract.mjs';
import { readRouterConfiguration } from './router-configuration.mjs';
import { openSnapshot } from './router-codex-transfer.mjs';

export function potCommand(repository, pot, arguments_, options = {}) {
  return boundedCommand(join(repository, 'bin/sandbox-exec'), arguments_, { ...options,
    env: { ...basicEnvironment(process.env, [...RUNTIME_SETTINGS, 'POTS_RUNTIME']), SANDBOX: pot } });
}

function verifyMacVersions(repository, routerApi, deadline) {
  const bootstrap = readFileSync(join(repository, 'session/bootstrap'), 'utf8');
  const magpie = bootstrap.match(/^MAGPIE_VERSION=(.+)$/mu)?.[1];
  const codex = bootstrap.match(/^CODEX_VERSION=(.+)$/mu)?.[1];
  if (!magpie || !codex) throw refuseCodex('unsupported version pins');
  if (boundedCommand('magpie', ['--version'], { deadline }).trim() !== `magpie ${magpie}` ||
      boundedCommand('codex', ['--version'], { deadline }).trim() !== `codex-cli ${codex}`) throw refuseCodex('Mac tool version drift');
  const hello = boundedCommand('curl', ['--silent', '--fail', '--max-time', '5', `${routerApi.slice(0, -3)}/api/hello`], { deadline });
  if (JSON.parse(hello).version !== magpie) throw refuseCodex('Mac gateway version drift');
}

function requireRoute(scope, machine, snapshot) {
  const expected = scope.routes[machine];
  const plan = codexPlan(upgradedSnapshot(snapshot));
  if (plan.target !== expected) throw refuseCodex('reviewed direct route, effort or account selector drift');
}

function samePortableConfiguration(mac, pot) {
  for (const field of ['providers', 'settings', 'wires']) {
    if (!isDeepStrictEqual(mac[field], pot[field])) throw refuseCodex('cross-machine configuration or binding incompatibility');
  }
}

export function codexPreflight(review, repository) {
  const deadline = Date.now() + PREFLIGHT_MS;
  reviewAdmission(review);
  checkReviewedSource(review.scope.source, repository, deadline);
  verifyResources(review.scope, repository);
  verifyMacVersions(repository, review.scope.routerEndpoints.mac, deadline);
  const mac = readRouterConfiguration();
  requireRoute(review.scope, 'mac', mac);
  const snapshots = { mac };
  for (const pot of CODEX_POTS) {
    potCommand(repository, pot, ['node', '/opt/agent-sandbox/session/codex-rollout.mjs', 'source'], { deadline, input: JSON.stringify(review.scope) });
    potCommand(repository, pot, ['/opt/agent-sandbox/session/bootstrap', '--router-current'], { deadline });
    const key = randomBytes(32).toString('hex');
    const envelope = potCommand(repository, pot, ['node', '/opt/agent-sandbox/session/router-codex-transfer.mjs', 'capture'], {
      deadline, input: JSON.stringify({ key }),
    });
    snapshots[pot] = openSnapshot(JSON.parse(envelope), key);
    requireRoute(review.scope, pot, snapshots[pot]);
    samePortableConfiguration(mac, snapshots[pot]);
  }
  if (review.scope.routes.nextnodeRecovery !== review.scope.routes.nextnode) throw refuseCodex('recovery route drift');
  if (Date.now() >= deadline) throw refuseCodex('aggregate preflight bound exhausted');
  return snapshots;
}
