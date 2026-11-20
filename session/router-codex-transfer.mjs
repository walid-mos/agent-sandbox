import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexJournal, durablePrivateFile, requirePrivateDirectory } from './codex-journal.mjs';
import { captureCredentialBaseline, compareCredentialBaseline } from './codex-credential-baseline.mjs';
import { CODEX_RECOVERY_TRANSFER_ACTIONS } from './codex-recovery-transfer-actions.mjs';
import { codexAnswers } from './router-codex-answers.mjs';
import { refuseCodex, requireSameSnapshot } from './router-codex-contract.mjs';
import { readPrivateJson, readRouterConfiguration } from './router-configuration.mjs';
import { main, runOperation } from './main.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSFER_TIMEOUT_MS = 120_000;

export function sealSnapshot(snapshot, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
  return { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
}

export function openSnapshot(envelope, key) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(envelope.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw refuseCodex('encrypted private transfer unreadable'); }
}

function receivePacket() {
  try {
    const packet = JSON.parse(readFileSync(0, 'utf8'));
    if (!/^[a-f0-9]{64}$/u.test(packet.key)) throw refuseCodex('invalid transport key');
    return packet;
  } catch { throw refuseCodex('private transport input unreadable'); }
}

async function validate(expectedPath, routerApi, journalPath) {
  const expected = readPrivateJson(expectedPath);
  requireSameSnapshot(expected, readRouterConfiguration());
  const journal = new CodexJournal(journalPath);
  await journal.step('direct-codex-request', async () => {
    for await (const line of codexAnswers(expected, routerApi)) process.stdout.write(`${line}\n`);
  }, () => {
    requireSameSnapshot(expected, readRouterConfiguration());
    return { isExactCodexAnswer: true, isConfigurationEqual: true, claude: 'DEFERRED' };
  });
}

function requireCurrentConfiguration(expectedPath) {
  requireSameSnapshot(readPrivateJson(expectedPath), readRouterConfiguration());
}

const recoveryBaselineDirectory = expectedPath => join(dirname(dirname(expectedPath)), 'recovery-credential-baseline');

function captureRecoveryCredentials([expectedPath]) {
  requireCurrentConfiguration(expectedPath);
  captureCredentialBaseline(recoveryBaselineDirectory(expectedPath));
  process.stdout.write('CODEX_TARGETED_V1: private recovery credential baseline retained locally\n');
}

function compareRecoveryCredentials([expectedPath]) {
  readPrivateJson(expectedPath);
  compareCredentialBaseline(recoveryBaselineDirectory(expectedPath));
  process.stdout.write('CODEX_TARGETED_V1: local credential bytes equal, Claude DEFERRED\n');
}

function compareConfiguration([expectedPath]) {
  requireCurrentConfiguration(expectedPath);
  process.stdout.write('CODEX_TARGETED_V1: configuration equal, Claude DEFERRED\n');
}

function inspectRecovery([expectedPath]) {
  compareRecoveryCredentials([expectedPath]);
  compareConfiguration([expectedPath]);
}

async function receiveRestore([routerApi]) {
  const packet = receivePacket();
  const payload = openSnapshot(packet.envelope, packet.key);
  const parent = join(homedir(), '.local/state/agent-sandbox/codex-runs');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  requirePrivateDirectory(parent);
  const directory = mkdtempSync(join(parent, 'restore-'));
  durablePrivateFile(join(directory, 'owner.json'), JSON.stringify({ contract: 'CODEX_TARGETED_V1', runId: payload.runId }));
  const source = join(directory, 'source.json');
  const seed = join(directory, 'seed.magpie-backup');
  durablePrivateFile(source, JSON.stringify(payload.source));
  durablePrivateFile(seed, Buffer.from(payload.seed, 'base64'));
  try {
    execFileSync(process.execPath, [join(HERE, 'router-codex-restore.mjs'), seed, source, join(directory, 'restore')], {
      input: payload.passphrase, timeout: TRANSFER_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'],
    });
    await validate(join(directory, 'restore/expected.json'), routerApi, join(directory, 'validation'));
  } catch { throw refuseCodex(`remote restore or validation failed. Retained private journal ${directory}. No retry`); }
  process.stdout.write(`CODEX_TARGETED_V1: retained ${directory}/restore/expected.json\n`);
}

main(import.meta, () => runOperation({
  capture: () => {
    const { key } = receivePacket();
    process.stdout.write(JSON.stringify(sealSnapshot(readRouterConfiguration(), key)));
  },
  restore: receiveRestore,
  verify: ([expectedPath, routerApi, journalPath]) => validate(expectedPath, routerApi, journalPath),
  [CODEX_RECOVERY_TRANSFER_ACTIONS.CAPTURE_CREDENTIALS]: captureRecoveryCredentials,
  compare: compareConfiguration,
  [CODEX_RECOVERY_TRANSFER_ACTIONS.COMPARE_CREDENTIALS]: compareRecoveryCredentials,
  [CODEX_RECOVERY_TRANSFER_ACTIONS.INSPECT_RECOVERY]: inspectRecovery,
}, `usage: router-codex-transfer.mjs capture|restore API|verify EXPECTED API JOURNAL|${CODEX_RECOVERY_TRANSFER_ACTIONS.CAPTURE_CREDENTIALS} EXPECTED|${CODEX_RECOVERY_TRANSFER_ACTIONS.COMPARE_CREDENTIALS} EXPECTED|compare EXPECTED|${CODEX_RECOVERY_TRANSFER_ACTIONS.INSPECT_RECOVERY} EXPECTED`));
