import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const { runOperation } = await import('./main.mjs');
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
let branch;
let leaf;
let onShutdown;

function serve() {
  const logFailure = (_subject, error) => { throw error; };
  serveQueue(terminals, logFailure, createAdmission({ logFailure, readText: healthyWorkerMemory }));
  worker = workers().find(candidate => candidate.name === worker.name);
}

function inspect() {
  const queue = queued();
  inspectWorker(worker, { terminals, now: Date.now(), queue, resting: new Map(), pending: new Set(queue.map(request => request.worker)) });
  worker = workers().find(candidate => candidate.name === worker.name);
}

function startRuntime() {
  process.env.HC_TERMINAL_ID = worker.terminal;
  const sessionFile = join(worker.worktree, 'conversation.jsonl');
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, '{"type":"session","id":"task"}\n');
  leaf = 'leaf';
  branch = [{ id: leaf, type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Report ready.' }] } }];
  context = { cwd: worker.worktree, isIdle: () => true, hasPendingMessages: () => false,
    shutdown: () => { shutdowns += 1; onShutdown?.(); }, ui: { getEditorText: () => '', onTerminalInput: () => () => {} },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'task', getLeafId: () => leaf, getBranch: () => branch } };
  runtime = new WorkerRuntime({ events: { emit: (_event, request) => {
    request.result = { version: 1, asyncRuns: 0, waitSubscriptions: 0, awaited: 0 };
  } } }, worker);
  runtime.start(context);
}

beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 60_000 * (serial + 1) });
  calls.length = 0;
  terminals = [];
  shutdowns = 0;
  onShutdown = undefined;
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

async function dispatch(operation, ...args) {
  const originalArgs = process.argv;
  try {
    process.argv = [process.execPath, 'dispatch.mjs', operation, ...args];
    await import(`./dispatch.mjs?acknowledged-task=${operation}`);
  } finally {
    process.argv = originalArgs;
  }
}

function reportWithTiming(timers) {
  writeFileSync(worker.resultFile, 'Reviewed evidence.');
  terminals = terminals.map(terminal => ({ ...terminal, status: 'done' }));
  const sessionFile = context.sessionManager.getSessionFile();
  appendFileSync(sessionFile, `${JSON.stringify(branch[0])}\n`);
  runtime.settle(context);
  const timing = { id: 'timing', parentId: leaf, type: 'custom', customType: 'pi-hud-telemetry-prompt-timing-v2' };
  leaf = timing.id;
  branch.push(timing);
  appendFileSync(sessionFile, `${JSON.stringify(timing)}\n`);
  timers.tick(SETTLED_GRACE_MS);
  inspect();
  return sessionFile;
}

for (const [guard, change] of Object.entries({
  'pending messages': () => { context.hasPendingMessages = () => true; },
  'unknown metadata': () => branch.push({ id: leaf = 'new', type: 'custom', customType: 'unknown' }),
  'unread assistant output': () => branch.push({ ...branch[0], id: leaf = 'new' }),
  'a branch without the settled leaf': () => { branch = branch.slice(1); },
  'a changed session identity': () => { context.sessionManager.getSessionId = () => 'another-session'; },
})) {
  test(`${guard} keeps the acknowledged worker open after timing metadata`, ({ mock: { timers } }) => {
    reportWithTiming(timers);
    acknowledgeResult([worker.name, worker.result.id]);
    change();
    runtime.finish(context);
    assert.equal(shutdowns, 0);
  });
}

test('dispatcher acknowledges a done worker with timing metadata and resumes its exact session', { timeout: 5_000 }, async t => {
  t.mock.module('./main.mjs', { exports: { runOperation, main: (_module, body) => body() } });
  const sessionFile = reportWithTiming(t.mock.timers);
  const reportedTranscript = readFileSync(worker.result.transcript, 'utf8');
  assert.match(reportedTranscript, /pi-hud-telemetry-prompt-timing-v2/);
  const closed = new Promise(resolve => { onShutdown = resolve; });
  await dispatch('finish', worker.name, worker.result.id);
  await closed;
  runtime.stop();
  terminals = [];
  inspect();
  assert.equal(worker.isClosed, true);
  assert.deepEqual(queued(), []);
  const messageFile = join(worker.worktree, 'follow-up.md');
  writeFileSync(messageFile, 'Continue reviewing.');
  await dispatch('send', worker.name, messageFile);
  serve();
  const launch = calls.filter(call => call.args[0] === 'run').at(-1).args;
  assert.equal(launch[launch.indexOf('--session') + 1], sessionFile);
  assert.equal(worker.sessionId, 'task');
  assert.equal(readFileSync(sessionFile, 'utf8'), reportedTranscript);
  assert.equal(queued()[0].message, 'Continue reviewing.');
  startRuntime();
  serve();
  const wrapped = calls.find(call => call.args[0] === 'send').args.at(-1);
  assert.equal(runtime.input({ text: wrapped }, context).text, 'Continue reviewing.');
  serve();
  assert.deepEqual(queued(), []);
});

test('a stopped task resumes its exact session through the same queue without creating a branch or PR', ({ mock: { timers } }) => {
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
  timers.tick(5_000);
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
