import { spawn } from 'node:child_process';
import { CodexJournal } from './codex-journal.mjs';
import { refuseCodex } from './router-codex-contract.mjs';

import { READ_COMMAND_MS, RECOVERY_COMMAND_MS, RECOVERY_VALIDATION_MS } from './codex-limits.mjs';
const OUTPUT_BYTES = 64 * 1024;

export function recoveryCommand({ file, arguments: arguments_, environment }, timeout = RECOVERY_COMMAND_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, { env: environment || process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    const timeoutHandle = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeout);
    child.stdout.on('data', chunk => { if (stdout.length < OUTPUT_BYTES) stdout += chunk; });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timeoutHandle); reject(refuseCodex('recovery process could not start')); });
    child.once('close', status => {
      clearTimeout(timeoutHandle);
      if (status !== 0) reject(refuseCodex('recovery command failed or timed out'));
      else resolve(stdout);
    });
  });
}

async function measuredStep(journal, name, command, measurement, timeout) {
  await journal.step(name, () => recoveryCommand(command, timeout), async () => {
    const report = await recoveryCommand(measurement, READ_COMMAND_MS);
    if (!report.trim()) throw refuseCodex('empty recovery measurement');
    return { isCommandSuccessful: true, isMeasured: true };
  });
}

async function inspectFailure(journal, command) {
  journal.record('failure-inspection', 'INTENT');
  try {
    await recoveryCommand(command, READ_COMMAND_MS);
    journal.record('failure-inspection', 'CONFIRMED', { isReadOnlyInspectionSuccessful: true });
  } catch { journal.record('failure-inspection', 'UNKNOWN'); }
}

export async function runCodexRecovery({ journalPath, gate, commands }) {
  await gate();
  const journal = new CodexJournal(journalPath);
  const deferCancellation = () => journal.record('recovery-unit', 'CANCEL_DEFERRED');
  process.on('SIGINT', deferCancellation);
  process.on('SIGTERM', deferCancellation);
  try {
    await measuredStep(journal, 'restart', commands.restart, commands.restartMeasure);
    await measuredStep(journal, 'bootstrap', commands.bootstrap, commands.bootstrapMeasure);
    await measuredStep(journal, 'verification', commands.verify, commands.verifyMeasure, RECOVERY_VALIDATION_MS);
    journal.record('recovery-unit', 'CONFIRMED', { claude: 'DEFERRED', workerResume: 'OWNER_RECONCILIATION_REQUIRED' });
  } catch (error) {
    await inspectFailure(journal, commands.inspect);
    throw error;
  } finally {
    process.off('SIGINT', deferCancellation);
    process.off('SIGTERM', deferCancellation);
  }
}
