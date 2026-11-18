import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCodexRecovery } from './codex-recovery.mjs';

function recoveryFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, 'trace');
  const script = join(directory, 'process.mjs');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
const [trace, step, exitCode] = process.argv.slice(2);
appendFileSync(trace, step + '\\n');
if (step === 'restart') process.kill(process.ppid, 'SIGTERM');
if (step === 'bootstrap') process.kill(process.ppid, 'SIGINT');
process.stdout.write('measured\\n');
process.exitCode = Number(exitCode);
`);
  const command = (step, exitCode = 0) => ({ file: process.execPath, arguments: [script, trace, step, String(exitCode)] });
  return { directory, trace, command, options: { journalPath: join(directory, 'journal'), gate: () => {},
    commands: Object.fromEntries(['restart', 'restartMeasure', 'bootstrap', 'bootstrapMeasure', 'verify', 'verifyMeasure', 'inspect'].map(step => [step, command(step)])) } };
}

test('recovery continues restart bootstrap verification despite cancellation and an expired admission window after restart', async t => {
  const fixture = recoveryFixture(t);
  let gates = 0;
  fixture.options.gate = () => {
    gates += 1;
    if (gates > 1) throw new Error('window expired');
  };
  await runCodexRecovery(fixture.options);
  assert.equal(gates, 1);
  assert.equal(readFileSync(fixture.trace, 'utf8'), 'restart\nrestartMeasure\nbootstrap\nbootstrapMeasure\nverify\nverifyMeasure\n');
  const events = readFileSync(join(fixture.directory, 'journal/events.jsonl'), 'utf8');
  assert.match(events, /CANCEL_DEFERRED/u);
  assert.match(events, /"step":"verification","state":"CONFIRMED"/u);
  await assert.rejects(runCodexRecovery(fixture.options));
  assert.equal(readFileSync(fixture.trace, 'utf8').split('restart\n').length - 1, 1);
});

test('real bootstrap failure stops with UNKNOWN and one read-only inspection without retry or verification', async t => {
  const fixture = recoveryFixture(t);
  fixture.options.commands.bootstrap = fixture.command('bootstrap', 7);
  await assert.rejects(runCodexRecovery(fixture.options), /bootstrap failed/u);
  assert.equal(readFileSync(fixture.trace, 'utf8'), 'restart\nrestartMeasure\nbootstrap\ninspect\n');
  assert.match(readFileSync(join(fixture.directory, 'journal/events.jsonl'), 'utf8'), /"step":"bootstrap","state":"UNKNOWN"/u);
});

test('real restart failure stops before bootstrap and inspects only once', async t => {
  const fixture = recoveryFixture(t);
  fixture.options.commands.restart = fixture.command('restart', 9);
  await assert.rejects(runCodexRecovery(fixture.options), /restart failed/u);
  assert.equal(readFileSync(fixture.trace, 'utf8'), 'restart\ninspect\n');
});

test('closed whole-unit gate launches no process', async t => {
  const fixture = recoveryFixture(t);
  fixture.options.gate = () => { throw new Error('approval absent'); };
  await assert.rejects(runCodexRecovery(fixture.options), /approval absent/u);
});
