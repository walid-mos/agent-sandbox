import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { sandboxFixture } from '../probes/fixtures/sandbox.mjs';
import { healthyWorkerMemory } from '../probes/fixtures/worker-memory.mjs';

const { home } = sandboxFixture('worker-task-');
const calls = [];
let terminals = [];
let serial = 0;
mock.module('./run.mjs', { exports: { WITH_VAULT: '/unused', failureReason: error => error.message, command(binary, args) {
  calls.push({ binary, args });
  if (binary === 'pots') return '';
  if (binary === 'pi' && args[0] === '--help') return '';
  if (binary !== 'hc') throw new Error(`Task invoked forbidden command ${binary}`);
  if (args[0] === 'ls') return JSON.stringify({ terminals });
  if (args[0] === 'get') return JSON.stringify(terminals.find(terminal => [terminal.name, terminal.address].includes(args.at(-1))));
  if (args[0] === 'read') return 'Report ready.';
  if (args[0] === 'run') {
    const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
    terminals.push({ name: args[args.indexOf('--name') + 1], address: `terminal-${++serial}`, state: 'live', status: 'idle',
      cwd: args[args.indexOf('--cwd') + 1], labels });
    return '';
  }
  if (args[0] === 'kill') { terminals = terminals.map(terminal => ({ ...terminal, state: 'finished' })); return ''; }
  if (args[0] === 'rm') { terminals = []; return ''; }
  if (args[0] === 'send') return '';
  throw new Error(`Unexpected hc command ${args[0]}`);
} } });
const { inspectWorker } = await import('./inspect-worker.mjs');
const { runCommand } = await import('./commands.mjs');
const { enqueue, queued } = await import('./queue.mjs');
const { serveQueue } = await import('./serve-queue.mjs');
const { createAdmission } = await import('./worker-admission.mjs');
const { WorkerRuntime } = await import('./worker-runtime.mjs');
const { SETTLED_GRACE_MS, receiptPath, statePath } = await import('./worker-lifecycle.mjs');
const { acknowledgeResult } = await import('./worker-results.mjs');
const { clearStop, endTerminal, markStopped, save, workers } = await import('./workers.mjs');
const { readJson } = await import('./private-json.mjs');
let worker;
let runtime;
let context;
let shutdowns;

function serve() {
  const logFailure = (_subject, error) => { throw error; };
  serveQueue(terminals, logFailure, createAdmission({ logFailure, readText: healthyWorkerMemory }));
  worker = workers().find(candidate => candidate.name === worker.name);
}

function inspect() {
  const queue = queued();
  inspectWorker(worker, { terminals, now: Date.now(), queue, pending: new Set(queue.map(request => request.worker)) });
  worker = workers().find(candidate => candidate.name === worker.name);
}

function startRuntime() {
  process.env.HC_TERMINAL_ID = worker.terminal;
  const sessionFile = join(worker.worktree, 'conversation.jsonl');
  writeFileSync(sessionFile, '{"type":"session","id":"task"}\n');
  context = { cwd: worker.worktree, isIdle: () => true, hasPendingMessages: () => false,
    shutdown: () => { shutdowns += 1; }, ui: { getEditorText: () => '', onTerminalInput: () => () => {} },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'task', getLeafId: () => 'leaf',
      getBranch: () => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Report ready.' }] } }] } };
  runtime = new WorkerRuntime({ events: { emit: (_event, request) => {
    request.result = { version: 1, asyncRuns: 0, waitSubscriptions: 0, awaited: 0 };
  } } }, worker);
  runtime.start(context);
}

beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  calls.length = 0;
  terminals = [];
  shutdowns = 0;
  const directory = join(home, `task-${++serial}`);
  mkdirSync(directory);
  mkdirSync(join(directory, '.git'));
  worker = { name: `task-${serial}`, kind: 'task', owner: 'proof', title: 'Read one report', scope: 'Read and summarize',
    worktree: directory, brief: join(directory, 'brief.md'), resultFile: join(directory, 'result.md') };
  writeFileSync(worker.brief, 'Read and summarize.');
  save(worker);
  enqueue({ worker: worker.name });
  serve();
  startRuntime();
});
afterEach(() => runtime.stop());

test('model commands identify a task by its title both when sent and when its terminal is gone', () => {
  const configuration = join(home, '.pi/agent');
  mkdirSync(configuration, { recursive: true });
  writeFileSync(join(configuration, 'settings.json'), JSON.stringify({ enabledModels: ['magpie/group/router'] }));
  const input = { name: 'model', argument: 'router', worker };
  assert.equal(runCommand(input), 'Sent /model magpie/group/router to Read one report.');
  endTerminal(worker, terminals);
  assert.throws(() => runCommand(input), /Read one report is not running/);
});

test('a task launches visibly and closes only after its result and exact coordinator acknowledgement, without Git', t => {
  const launch = calls.find(call => call.args[0] === 'run').args;
  assert.ok(launch.includes('pots.worker=true'));
  assert.ok(launch.includes('herdr.space=sppots'));
  assert.ok(launch.includes(`herdr.tab=tb${worker.name}`));
  assert.ok(launch.includes('magpie/group/router'));
  assert.ok(launch.includes('agent.title=Read one report'));
  runtime.settle(context);
  t.mock.timers.tick(SETTLED_GRACE_MS);
  inspect();
  assert.equal(worker.result, undefined);
  writeFileSync(worker.resultFile, 'Reviewed evidence.');
  inspect();
  assert.ok(worker.result.id);
  assert.equal(readFileSync(worker.result.transcript, 'utf8'), '{"type":"session","id":"task"}\n');
  runtime.finish(context);
  assert.equal(shutdowns, 0);
  acknowledgeResult([worker.name, worker.result.id]);
  assert.ok(existsSync(receiptPath(worker)));
  runtime.finish(context);
  assert.equal(shutdowns, 1);
  assert.equal(readJson(statePath(worker)).phase, 'closing');
  assert.equal(calls.some(call => ['git', 'gh', 'bash'].includes(call.binary)), false);
});

test('a stopped task resumes its exact session through the same queue without creating a branch or PR', () => {
  inspect();
  const sessionFile = worker.sessionFile;
  const launchId = worker.launchId;
  markStopped(worker);
  endTerminal(worker, terminals);
  runtime.stop();
  enqueue({ worker: worker.name, message: 'Read another section within this scope.' });
  serve();
  assert.equal(terminals.length, 0);
  clearStop(worker);
  enqueue({ worker: worker.name, message: 'Read another section within this scope.' });
  serve();
  assert.notEqual(worker.launchId, launchId);
  assert.equal(worker.kind, 'task');
  assert.equal(worker.repository, undefined);
  assert.equal(worker.pullRequest, undefined);
  const resumed = calls.filter(call => call.args[0] === 'run').at(-1).args;
  assert.equal(resumed[resumed.indexOf('--session') + 1], sessionFile);
  startRuntime();
  serve();
  const message = calls.find(call => call.args[0] === 'send').args.at(-1);
  runtime.input({ text: message }, context);
  serve();
  assert.equal(queued().filter(request => request.worker === worker.name).length, 0);
  assert.equal(calls.some(call => ['git', 'gh', 'bash'].includes(call.binary)), false);
});
