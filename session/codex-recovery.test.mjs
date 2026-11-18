import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCodexRecovery } from './codex-recovery.mjs';

function recoveryFixture(t, isCredentialMutation = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, 'trace');
  const script = join(directory, 'process.mjs');
  const credentialPath = join(directory, 'credential.bin');
  const baselinePath = join(directory, 'credential-baseline.bin');
  writeFileSync(credentialPath, Buffer.from('synthetic private credential bytes'));
  writeFileSync(script, `import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
const [trace, step, exitCode, credentialPath, baselinePath, isCredentialMutation] = process.argv.slice(2);
appendFileSync(trace, step + '\\n');
if (step === 'captureCredentials') copyFileSync(credentialPath, baselinePath);
if (step === 'bootstrap' && isCredentialMutation === 'true') writeFileSync(credentialPath, Buffer.from('changed synthetic credential bytes'));
if ((step === 'compareCredentials' || step === 'inspect') && !readFileSync(credentialPath).equals(readFileSync(baselinePath))) process.exitCode = 9;
if (step === 'restart') process.kill(process.ppid, 'SIGTERM');
if (step === 'bootstrap') process.kill(process.ppid, 'SIGINT');
process.stdout.write('measured\\n');
if (!process.exitCode) process.exitCode = Number(exitCode);
`);
  const command = (step, exitCode = 0) => ({ file: process.execPath, arguments: [script, trace, step, String(exitCode), credentialPath, baselinePath, String(isCredentialMutation)] });
  const steps = ['captureCredentials', 'compareCredentials', 'restart', 'restartMeasure', 'bootstrap', 'bootstrapMeasure', 'verify', 'verifyMeasure', 'inspect'];
  return { directory, trace, command, options: { journalPath: join(directory, 'journal'), gate: () => {},
    commands: Object.fromEntries(steps.map(step => [step, command(step)])) } };
}

test('recovery continues restart bootstrap verification and checks the original credential bytes throughout', async t => {
  const fixture = recoveryFixture(t);
  let gates = 0;
  fixture.options.gate = () => {
    gates += 1;
    if (gates > 1) throw new Error('window expired');
  };
  await runCodexRecovery(fixture.options);
  assert.equal(gates, 1);
  assert.equal(readFileSync(fixture.trace, 'utf8'), 'captureCredentials\ncompareCredentials\nrestart\nrestartMeasure\nbootstrap\ncompareCredentials\nbootstrapMeasure\nverify\ncompareCredentials\nverifyMeasure\n');
  const events = readFileSync(join(fixture.directory, 'journal/events.jsonl'), 'utf8');
  assert.match(events, /CANCEL_DEFERRED/u);
  assert.match(events, /"step":"verification","state":"CONFIRMED"/u);
  await assert.rejects(runCodexRecovery(fixture.options));
  assert.equal(readFileSync(fixture.trace, 'utf8').split('restart\n').length - 1, 1);
});

test('recovery refuses a credential mutation during bootstrap against the retained pre-restart baseline', async t => {
  const fixture = recoveryFixture(t, true);
  await assert.rejects(runCodexRecovery(fixture.options), /bootstrap failed/u);
  assert.equal(readFileSync(fixture.trace, 'utf8'), 'captureCredentials\ncompareCredentials\nrestart\nrestartMeasure\nbootstrap\ncompareCredentials\ninspect\n');
  const events = readFileSync(join(fixture.directory, 'journal/events.jsonl'), 'utf8');
  assert.match(events, /"step":"bootstrap","state":"UNKNOWN"/u);
  assert.doesNotMatch(events, /"step":"verification","state":"CONFIRMED"/u);
});

test('real bootstrap failure stops with UNKNOWN and one read-only inspection without retry or verification', async t => {
  const fixture = recoveryFixture(t);
  fixture.options.commands.bootstrap = fixture.command('bootstrap', 7);
  await assert.rejects(runCodexRecovery(fixture.options), /bootstrap failed/u);
  assert.equal(readFileSync(fixture.trace, 'utf8'), 'captureCredentials\ncompareCredentials\nrestart\nrestartMeasure\nbootstrap\ninspect\n');
  assert.match(readFileSync(join(fixture.directory, 'journal/events.jsonl'), 'utf8'), /"step":"bootstrap","state":"UNKNOWN"/u);
});

test('real restart failure stops before bootstrap and inspects only once', async t => {
  const fixture = recoveryFixture(t);
  fixture.options.commands.restart = fixture.command('restart', 9);
  await assert.rejects(runCodexRecovery(fixture.options), /restart failed/u);
  assert.equal(readFileSync(fixture.trace, 'utf8'), 'captureCredentials\ncompareCredentials\nrestart\ninspect\n');
});

test('closed whole-unit gate launches no process', async t => {
  const fixture = recoveryFixture(t);
  fixture.options.gate = () => { throw new Error('approval absent'); };
  await assert.rejects(runCodexRecovery(fixture.options), /approval absent/u);
});
