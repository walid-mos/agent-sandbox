import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexJournal, durablePrivateFile } from './codex-journal.mjs';
import { main, runOperation } from './main.mjs';
import { runCodexRecovery } from './codex-recovery.mjs';
import { CODEX_RECOVERY_TRANSFER_ACTIONS } from './codex-recovery-transfer-actions.mjs';
import { codexPreflight } from './codex-preflight.mjs';
import { checkReviewedSource, CODEX_POTS, reviewAdmission, sha256, verifyResources } from './codex-review.mjs';
import { codexAnswers } from './router-codex-answers.mjs';
import { refuseCodex, requireSameSnapshot, upgradedSnapshot } from './router-codex-contract.mjs';
import { magpieConfigurationCommand, readLocalCredentialBytes, readPrivateJson, readRouterConfiguration, requireCredentialBytesEqual } from './router-configuration.mjs';
import { basicEnvironment, RUNTIME_SETTINGS } from './environment.mjs';
import { requireOwnerHolds } from './codex-owner-holds.mjs';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND_MS = 300_000;
async function backupMac(journal, snapshot) {
  const credentialBytes = readLocalCredentialBytes();
  const passphrase = `${randomBytes(24).toString('hex')}\n`;
  const backup = join(journal.path, 'mac-before.magpie-backup');
  durablePrivateFile(join(journal.path, 'mac-backup-passphrase'), passphrase);
  await journal.step('mac-private-backup', () => magpieConfigurationCommand(['backup', '--no-library', backup], { input: passphrase }), () => {
    requireCredentialBytesEqual(credentialBytes, readLocalCredentialBytes());
    requireSameSnapshot(snapshot, readRouterConfiguration());
    if (!statSync(backup).size) throw refuseCodex('private Mac backup missing');
    return { isPrivateBackupPresent: true, isConfigurationUnchanged: true, areLocalCredentialBytesUnchanged: true };
  });
}

function inspectMacFailure(journal) {
  journal.record('mac-failure-inspection', 'INTENT');
  try {
    durablePrivateFile(join(journal.path, 'mac-failure-inspection.json'), JSON.stringify(readRouterConfiguration()));
    journal.record('mac-failure-inspection', 'CONFIRMED', { isPrivateSnapshotRetained: true });
  } catch { journal.record('mac-failure-inspection', 'UNKNOWN'); }
}

async function applyMacGroups(journal, before, candidate) {
  let expected = structuredClone(before);
  for (const id of ['deep', 'expert']) {
    const replacement = candidate.providers.groups.find(group => group.id === id);
    const credentialBytes = readLocalCredentialBytes();
    const next = structuredClone(expected);
    next.providers.groups = next.providers.groups.map(group => group.id === id ? structuredClone(replacement) : group);
    await journal.step(`mac-group-${id}`, () => magpieConfigurationCommand(['group', 'set', id, `models=${replacement.members.join(',')}`]), () => {
      requireCredentialBytesEqual(credentialBytes, readLocalCredentialBytes());
      requireSameSnapshot(next, readRouterConfiguration());
      return { isOnlyReviewedGroupChanged: true, areLocalCredentialBytesUnchanged: true };
    });
    expected = next;
  }
}

async function seedPots(journal, scope, admission) {
  const retained = {};
  for (const pot of CODEX_POTS) {
    admission();
    let report;
    await journal.step(`seed-and-direct-${pot}`, () => {
      report = execFileSync(join(REPOSITORY, 'bin/router-seed-codex'), [join(journal.path, 'mac-before.json'),
        join(journal.path, 'mac-candidate.json'), join(journal.path, `seed-${pot}`), scope.routerEndpoints[pot]], {
        encoding: 'utf8', timeout: COMMAND_MS, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...basicEnvironment(process.env, [...RUNTIME_SETTINGS, 'POTS_RUNTIME']), SANDBOX: pot },
      });
    }, () => {
      const path = report.match(/^CODEX_TARGETED_V1: retained (\/[a-zA-Z0-9_./-]+\/\.local\/state\/agent-sandbox\/codex-runs\/restore-[^/\n]+\/restore\/expected.json)$/mu)?.[1];
      if (!path) throw refuseCodex('remote measured acknowledgement absent');
      retained[pot] = path;
      return { expectedSnapshotPath: path, isExactCodexConfirmed: true, claude: 'DEFERRED' };
    });
  }
  return retained;
}

function recoveryCommands(expected, runId, routerApi) {
  const environment = { ...basicEnvironment(process.env, [...RUNTIME_SETTINGS, 'POTS_RUNTIME']), SANDBOX: 'nextnode' };
  const host = (file, arguments_) => ({ file: join(REPOSITORY, 'bin', file), arguments: arguments_, environment });
  const transfer = action => host('sandbox-exec', ['node', '/opt/agent-sandbox/session/router-codex-transfer.mjs', action, expected]);
  const compare = transfer('compare');
  return {
    captureCredentials: transfer(CODEX_RECOVERY_TRANSFER_ACTIONS.CAPTURE_CREDENTIALS),
    compareCredentials: transfer(CODEX_RECOVERY_TRANSFER_ACTIONS.COMPARE_CREDENTIALS),
    restart: host('pots-session', ['restart']), restartMeasure: host('pots-session', ['name']),
    bootstrap: host('session-bootstrap', ['--codex-targeted', expected]), bootstrapMeasure: compare,
    verify: host('sandbox-exec', ['node', '/opt/agent-sandbox/session/router-codex-transfer.mjs', 'verify', expected, routerApi,
      join(dirname(dirname(expected)), `recovery-${runId}`)]), verifyMeasure: compare, inspect: transfer(CODEX_RECOVERY_TRANSFER_ACTIONS.INSPECT_RECOVERY),
  };
}

async function execute([reviewPath]) {
  const review = readPrivateJson(reviewPath);
  let isCancelled = false;
  const cancel = () => { isCancelled = true; };
  const admission = () => {
    if (isCancelled) throw refuseCodex('cancelled before the next operation');
    reviewAdmission(review);
    requireOwnerHolds(review);
  };
  admission();
  const snapshots = codexPreflight(review, REPOSITORY);
  admission();
  const journal = new CodexJournal(review.scope.runDirectory);
  const candidate = upgradedSnapshot(snapshots.mac);
  durablePrivateFile(join(journal.path, 'mac-before.json'), JSON.stringify(snapshots.mac));
  durablePrivateFile(join(journal.path, 'mac-candidate.json'), JSON.stringify(candidate));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    await backupMac(journal, snapshots.mac);
    await journal.step('mac-direct-codex', async () => {
      admission();
      requireSameSnapshot(snapshots.mac, readRouterConfiguration());
      for await (const line of codexAnswers(candidate, review.scope.routerEndpoints.mac)) process.stdout.write(`${line}\n`);
    }, () => {
      requireSameSnapshot(snapshots.mac, readRouterConfiguration());
      return { isExactCodexAnswer: true, isConfigurationUnchanged: true };
    });
    admission();
    await applyMacGroups(journal, snapshots.mac, candidate);
    const retained = await seedPots(journal, review.scope, admission);
    await runCodexRecovery({ journalPath: join(journal.path, 'nextnode-recovery'), gate: admission,
      commands: recoveryCommands(retained.nextnode, journal.runId, review.scope.routerEndpoints.nextnode) });
    journal.record('codex-targeted-run', 'CONFIRMED', { claude: 'DEFERRED', fullGroupHealth: 'UNPROVEN', resume: 'OWNER_ONLY_AFTER_RECONCILIATION' });
    process.stdout.write('CODEX_TARGETED_V1: six direct application requests confirmed, Claude DEFERRED, group health UNPROVEN\n');
  } catch (error) {
    inspectMacFailure(journal);
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

main(import.meta, () => runOperation({
  plan: ([reviewPath]) => {
    const review = readPrivateJson(reviewPath);
    process.stdout.write(`CODEX_TARGETED_V1: proposed scope ${sha256(JSON.stringify(review.scope))}, six direct application requests, Claude DEFERRED\n`);
    reviewAdmission(review);
    checkReviewedSource(review.scope.source, REPOSITORY);
    verifyResources(review.scope, REPOSITORY);
    process.stdout.write('CODEX_TARGETED_V1: local review checks passed. Remote preflight and execution have not run.\n');
  },
  source: () => {
    let scope;
    try { scope = JSON.parse(readFileSync(0, 'utf8')); } catch { throw refuseCodex('unreadable source scope'); }
    checkReviewedSource(scope.source, REPOSITORY);
    verifyResources(scope, REPOSITORY);
    process.stdout.write('CODEX_TARGETED_V1: source and resources exact\n');
  },
  execute,
}, 'usage: codex-rollout plan PRIVATE_REVIEW | execute PRIVATE_REVIEW | source'));
