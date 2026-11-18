import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { basicEnvironment, RUNTIME_SETTINGS } from './environment.mjs';
import { boundedCommand, checkReviewedSource, CODEX_POTS, PREFLIGHT_MS, reviewAdmission, verifyResources } from './codex-review.mjs';
import { codexPlan, refuseCodex, upgradedSnapshot } from './router-codex-contract.mjs';
import { readLocalCredentialBytes, readRouterConfiguration, requireCredentialBytesEqual } from './router-configuration.mjs';
import { openSnapshot } from './router-codex-transfer.mjs';
import { requireCodexCapability } from './codex-catalog.mjs';
import { requireEqual, requireString } from './codex-validation.mjs';

export function potCommand(repository, pot, arguments_, options = {}) {
  return boundedCommand(join(repository, 'bin/sandbox-exec'), arguments_, { ...options,
    env: { ...basicEnvironment(process.env, [...RUNTIME_SETTINGS, 'POTS_RUNTIME']), SANDBOX: pot } });
}

function bootstrapPin(bootstrap, name) {
  const pin = bootstrap.match(new RegExp(`^${name}=(.+)$`, 'mu'))?.[1];
  requireString(pin, 'unsupported version pins');
  return pin;
}

function verifyMacVersions(repository, routerApi, deadline) {
  const bootstrap = readFileSync(join(repository, 'session/bootstrap'), 'utf8');
  const magpie = bootstrapPin(bootstrap, 'MAGPIE_VERSION');
  const codex = bootstrapPin(bootstrap, 'CODEX_VERSION');
  requireEqual(`magpie ${magpie}`, boundedCommand('magpie', ['--version'], { deadline }).trim(), 'Mac Magpie version drift');
  requireEqual(`codex-cli ${codex}`, boundedCommand('codex', ['--version'], { deadline }).trim(), 'Mac Codex version drift');
  const hello = boundedCommand('curl', ['--silent', '--fail', '--max-time', '5', `${routerApi.slice(0, -3)}/api/hello`], { deadline });
  requireEqual(magpie, JSON.parse(hello).version, 'Mac gateway version drift');
  return codex;
}

function verifyCodexCatalog(binary, version, deadline) {
  let catalog;
  try {
    catalog = JSON.parse(boundedCommand(binary, ['debug', 'models', '--bundled'], {
      deadline, env: basicEnvironment(process.env, RUNTIME_SETTINGS),
    }));
  } catch { throw refuseCodex('pinned Codex bundled catalog is unreadable'); }
  requireCodexCapability(catalog, version, version);
}

function verifyPotCatalog(repository, pot, version, deadline) {
  const installed = potCommand(repository, pot, ['codex', '--version'], { deadline }).trim();
  requireEqual(`codex-cli ${version}`, installed, 'pot Codex version drift');
  let catalog;
  try {
    catalog = JSON.parse(potCommand(repository, pot, ['codex', 'debug', 'models', '--bundled'], { deadline }));
  } catch { throw refuseCodex('pot pinned Codex bundled catalog is unreadable'); }
  requireCodexCapability(catalog, version, installed.replace(/^codex-cli /u, ''));
}

function requireRoute(scope, machine, snapshot) {
  const expected = scope.routes[machine];
  const route = upgradedSnapshot(snapshot);
  const selected = route.providers.groups.find(group => group.id === 'expert')?.members[0];
  const plan = codexPlan(route);
  if (selected !== expected || `${plan.target}#${plan.account}` !== expected) {
    throw refuseCodex('reviewed direct route, effort or account selector drift');
  }
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
  const codexVersion = verifyMacVersions(repository, review.scope.routerEndpoints.mac, deadline);
  verifyCodexCatalog('codex', codexVersion, deadline);
  const macCredentialBytes = readLocalCredentialBytes();
  const mac = readRouterConfiguration();
  requireRoute(review.scope, 'mac', mac);
  const snapshots = { mac };
  for (const pot of CODEX_POTS) {
    potCommand(repository, pot, ['node', '/opt/agent-sandbox/session/codex-rollout.mjs', 'source'], { deadline, input: JSON.stringify(review.scope) });
    potCommand(repository, pot, ['node', '/opt/agent-sandbox/session/router-codex-credentials.mjs'], { deadline });
    potCommand(repository, pot, ['/opt/agent-sandbox/session/bootstrap', '--router-current'], { deadline });
    verifyPotCatalog(repository, pot, codexVersion, deadline);
    const key = randomBytes(32).toString('hex');
    const envelope = potCommand(repository, pot, ['node', '/opt/agent-sandbox/session/router-codex-transfer.mjs', 'capture'], {
      deadline, input: JSON.stringify({ key }),
    });
    snapshots[pot] = openSnapshot(JSON.parse(envelope), key);
    requireRoute(review.scope, pot, snapshots[pot]);
    samePortableConfiguration(mac, snapshots[pot]);
  }
  if (review.scope.routes.nextnodeRecovery !== review.scope.routes.nextnode) throw refuseCodex('recovery route drift');
  requireCredentialBytesEqual(macCredentialBytes, readLocalCredentialBytes());
  if (Date.now() >= deadline) throw refuseCodex('aggregate preflight bound exhausted');
  return snapshots;
}
