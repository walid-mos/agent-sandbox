import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CodexJournal, durablePrivateFile } from './codex-journal.mjs';
import { CODEX_CONTRACT, refuseCodex, requireSameSnapshot, upgradedSnapshot, validateSnapshot } from './router-codex-contract.mjs';
import { magpieConfigurationCommand, readPrivateJson, readRouterConfiguration } from './router-configuration.mjs';
import { main } from './main.mjs';

function portable(snapshot) {
  return { providers: snapshot.providers, settings: snapshot.settings, wires: snapshot.wires };
}

export async function restoreCodexConfiguration({ seed, source, journalPath, passphrase }) {
  const before = readRouterConfiguration();
  const expected = upgradedSnapshot(before);
  const sourceSnapshot = readPrivateJson(source);
  validateSnapshot(sourceSnapshot);
  if (!isDeepStrictEqual(portable(expected), portable(sourceSnapshot))) throw refuseCodex('source and destination configuration are incompatible');
  const seedStat = lstatSync(seed);
  if (!seedStat.isFile() || seedStat.uid !== process.getuid() || (seedStat.mode & 0o077)) throw refuseCodex('seed must be private and owned');
  const journal = new CodexJournal(journalPath);
  durablePrivateFile(join(journalPath, 'before.json'), JSON.stringify(before));
  durablePrivateFile(join(journalPath, 'expected.json'), JSON.stringify(expected));
  durablePrivateFile(join(journalPath, 'backup-passphrase'), passphrase);
  const backup = join(journalPath, 'before.magpie-backup');
  await journal.step('private-backup', () => magpieConfigurationCommand(['backup', '--no-library', backup], { input: passphrase }), () => {
    if (!lstatSync(backup).isFile() || lstatSync(backup).size === 0) throw refuseCodex('backup missing');
    return { isBackupPresent: true };
  });
  try {
    await journal.step('restore-configuration', () =>
      magpieConfigurationCommand(['restore', '--no-agents', '--no-library', '--no-sign-ins', seed], { input: passphrase }), () => {
      requireSameSnapshot(expected, readRouterConfiguration());
      return { isConfigurationEqual: true, areCredentialBytesEqual: true };
    });
  } catch (error) {
    journal.record('failure-inspection', 'INTENT');
    try {
      durablePrivateFile(join(journalPath, 'failure-inspection.json'), JSON.stringify(readRouterConfiguration()));
      journal.record('failure-inspection', 'CONFIRMED', { isPrivateSnapshotRetained: true });
    } catch { journal.record('failure-inspection', 'UNKNOWN'); }
    throw error;
  }
  process.stdout.write(`${CODEX_CONTRACT}: configuration restored and compared, no health requests sent. Claude DEFERRED.\n`);
}

main(import.meta, async () => {
  const [seed, source, journalPath] = process.argv.slice(2);
  const passphrase = readFileSync(0, 'utf8');
  if (!/^[a-f0-9]{48}\n$/u.test(passphrase)) throw refuseCodex('expected a private seed passphrase on stdin');
  await restoreCodexConfiguration({ seed, source, journalPath, passphrase });
});
