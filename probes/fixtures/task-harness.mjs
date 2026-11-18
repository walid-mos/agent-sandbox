import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TASK_CONTRACT_VERSION } from '../../session/task-contract.mjs';

const root = dirname(import.meta.dirname);
const repository = dirname(root);
const preload = join(import.meta.dirname, 'task-boundary.mjs');
const execute = promisify(execFile);
const payload = input => ({ version: TASK_CONTRACT_VERSION, ...input });

async function controlAsync(folder, operation, input) {
  const reply = await execute(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks',
    '--import', preload, join(repository, 'session/control.mjs'), operation, JSON.stringify(payload(input))],
  { env: { ...process.env, POTS_TASK_FIXTURE: folder } });
  return JSON.parse(reply.stdout);
}

function invoke(folder, module, args) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-test-module-mocks',
    '--import', preload, join(repository, module), ...args],
  { encoding: 'utf8', env: { ...process.env, POTS_TASK_FIXTURE: folder } });
}

function commands(folder) {
  const run = (operation, input) => invoke(folder, 'session/control.mjs', [operation, JSON.stringify(payload(input))]);
  const control = (operation, input) => {
    const reply = run(operation, input);
    assert.equal(reply.status, 0, reply.stderr);
    return JSON.parse(reply.stdout);
  };
  const workerStep = operation => {
    const reply = invoke(folder, 'probes/fixtures/task-worker.mjs', [operation]);
    assert.equal(reply.status, 0, reply.stderr);
  };
  return { run, control, workerStep, controlAsync: (operation, input) => controlAsync(folder, operation, input), invoke: (module, args) => invoke(folder, module, args) };
}

export function fixture(t) {
  const started = performance.now();
  const folder = mkdtempSync(join(tmpdir(), 'herdr-handover-'));
  const marker = join(folder, 'owner.json');
  const registry = `${folder}.ownership.json`;
  const owner = { run: folder, worktree: repository, resource: folder, endpoint: 'filesystem-only', resources: [] };
  let executionStarted;
  t.after(() => {
    const cleanup = performance.now();
    t.diagnostic(`executionMs=${(cleanup - executionStarted).toFixed(2)}`);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).run, owner.run);
    assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), owner);
    rmSync(folder, { recursive: true });
    rmSync(registry);
    t.diagnostic(`cleanupMs=${(performance.now() - cleanup).toFixed(2)}`);
  });
  writeFileSync(marker, JSON.stringify(owner));
  writeFileSync(registry, JSON.stringify(owner));
  mkdirSync(join(folder, 'bot'));
  writeFileSync(join(folder, 'bot/bot.json'), JSON.stringify({ model: 'synthetic-router' }));
  const path = join(folder, 'boundary.json');
  writeFileSync(path, JSON.stringify({ terminals: [], calls: [], wakes: [], loseReply: false }));
  const read = () => JSON.parse(readFileSync(path, 'utf8'));
  const patch = changes => writeFileSync(path, JSON.stringify({ ...read(), ...changes }));
  const recordResource = resource => {
    owner.resources.push(resource);
    writeFileSync(registry, JSON.stringify(owner));
  };
  t.diagnostic(`setupMs=${(performance.now() - started).toFixed(2)}`);
  executionStarted = performance.now();
  return { folder, read, patch, recordResource, ...commands(folder) };
}

export function existingExecution(folder) {
  const cwd = join(folder, 'Development/example/project/.worktree/synthetic');
  const sessions = join(folder, '.pi/agent/sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const sessionFile = join(sessions, 'exact.jsonl');
  const transcript = '{"type":"session","id":"synthetic-session"}\n{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Synthetic final report."}]}}\n';
  writeFileSync(sessionFile, transcript);
  const terminal = { address: 't-synthetic-existing', name: 'synthetic-existing', cwd, argv: ['pi', '@synthetic-brief.md'],
    parent: 'synthetic-mac/t-parent', state: 'live', status: 'working', created_ms: 1000,
    labels: { 'pi.session': sessionFile } };
  return { terminal, sessionFile, transcript };
}

export const submission = { id: 'task-synthetic-001', target: 'synthetic', text: 'Produce the synthetic report.',
  provenance: { source: 'herdr', author: 'synthetic-person', reference: 'synthetic-thread' } };
