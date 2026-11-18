import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexJournal, durablePrivateFile } from './codex-journal.mjs';
import { main } from './main.mjs';
import { CODEX_POTS, planCodexUpgrade, refuseCodex, requireSameSnapshot } from './router-codex-contract.mjs';
import { magpieConfigurationCommand, readPrivateJson, readRouterConfiguration } from './router-configuration.mjs';
import { sealSnapshot } from './router-codex-transfer.mjs';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');
import { RESTORE_TRANSFER_MS } from './codex-limits.mjs';

main(import.meta, async () => {
  const [beforePath, candidatePath, journalPath, routerApi] = process.argv.slice(2);
  if (!CODEX_POTS.includes(process.env.SANDBOX)) throw refuseCodex('unsupported target pot');
  const source = readPrivateJson(candidatePath);
  planCodexUpgrade(readPrivateJson(beforePath), source);
  requireSameSnapshot(source, readRouterConfiguration());
  const journal = new CodexJournal(journalPath);
  const seed = join(journalPath, 'seed.magpie-backup');
  const passphrase = `${randomBytes(24).toString('hex')}\n`;
  durablePrivateFile(join(journalPath, 'seed-passphrase'), passphrase);
  await journal.step('capture-seed', () =>
    magpieConfigurationCommand(['backup', '--no-keys', '--no-library', seed], { input: passphrase }), () => {
    requireSameSnapshot(source, readRouterConfiguration());
    if (!statSync(seed).size) throw refuseCodex('empty seed backup');
    return { isSourceUnchanged: true, isSeedCaptured: true };
  });
  const key = randomBytes(32).toString('hex');
  const envelope = sealSnapshot({ runId: journal.runId, source, seed: readFileSync(seed).toString('base64'), passphrase }, key);
  let report = '';
  await journal.step('transfer-restore-and-direct-validation', () => {
    report = execFileSync(join(REPOSITORY, 'bin/sandbox-exec'), ['node', '/opt/agent-sandbox/session/router-codex-transfer.mjs',
      'restore', routerApi], {
      input: JSON.stringify({ key, envelope }), encoding: 'utf8', timeout: RESTORE_TRANSFER_MS, stdio: ['pipe', 'pipe', 'pipe'],
    });
  }, () => {
    if (!/^CODEX_TARGETED_V1: retained \/[a-zA-Z0-9_./-]+\/\.local\/state\/agent-sandbox\/codex-runs\/restore-[^/\n]+\/restore\/expected.json$/mu.test(report)) {
      throw refuseCodex('remote acknowledgement missing');
    }
    return { isRemoteRestoreAndExactCodexConfirmed: true, claude: 'DEFERRED' };
  });
  durablePrivateFile(join(journalPath, 'remote-report'), report);
  process.stdout.write(report);
});
