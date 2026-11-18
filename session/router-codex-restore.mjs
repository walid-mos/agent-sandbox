import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexJournal, durablePrivateFile } from './codex-journal.mjs';
import { CODEX_CONTRACT, refuseCodex, requireSameSnapshot, upgradedSnapshot, validateSnapshot } from './router-codex-contract.mjs';
import { magpieConfigurationCommand, readLocalCredentialBytes, readPrivateJson, readRouterConfiguration, requireCredentialBytesEqual, requirePrivateFile } from './router-configuration.mjs';
import { main } from './main.mjs';
import { requireEqual } from './codex-validation.mjs';

function portable(snapshot) {
  return { providers: snapshot.providers, settings: snapshot.settings, wires: snapshot.wires };
}

function inspectFailedRestore(journal) {
  journal.record('failure-inspection', 'INTENT');
  try {
    durablePrivateFile(join(journal.path, 'failure-inspection.json'), JSON.stringify(readRouterConfiguration()));
    journal.record('failure-inspection', 'CONFIRMED', { isPrivateSnapshotRetained: true });
  } catch { journal.record('failure-inspection', 'UNKNOWN'); }
}

export async function restoreCodexConfiguration({ seed, source, journalPath, passphrase }) {
  const credentialBytes = readLocalCredentialBytes();
  const before = readRouterConfiguration();
  const expected = upgradedSnapshot(before);
  const sourceSnapshot = readPrivateJson(source);
  validateSnapshot(sourceSnapshot);
  requireEqual(portable(expected), portable(sourceSnapshot), 'source and destination configuration are incompatible');
  requirePrivateFile(seed);
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
      requireCredentialBytesEqual(credentialBytes, readLocalCredentialBytes());
      requireSameSnapshot(expected, readRouterConfiguration());
      return { isConfigurationEqual: true, areLocalCredentialBytesUnchanged: true };
    });
  } catch (error) {
    inspectFailedRestore(journal);
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
