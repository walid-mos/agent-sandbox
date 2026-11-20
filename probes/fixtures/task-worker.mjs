import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN, UNKNOWN } from '../../session/door-requests.mjs';
import { DOOR_RETRY_MS } from '../../session/human-doors.mjs';
import { reconcileHuman } from '../../session/human-relay.mjs';
import { WorkerRuntime } from '../../session/worker-runtime.mjs';
import { inspectWorker } from '../../session/inspect-worker.mjs';
import { serveQueue } from '../../session/serve-queue.mjs';
import { createAdmission } from '../../session/worker-admission.mjs';
import { healthyWorkerMemory } from './worker-memory.mjs';
import { reportTasks } from '../../session/task-view.mjs';
import { allTerminals, save, workers } from '../../session/workers.mjs';
import { queued } from '../../session/queue.mjs';
import { lifecycleOf, SETTLED_GRACE_MS, statePath } from '../../session/worker-lifecycle.mjs';
import { writePrivateJson } from '../../session/private-json.mjs';

async function relayNotice() {
  const path = join(process.env.POTS_TASK_FIXTURE, 'boundary.json');
  const boundary = JSON.parse(readFileSync(path, 'utf8'));
  const previous = boundary.notice;
  const doors = {
    all: () => [],
    find: id => previous?.id === id ? previous : undefined,
    prepare: () => ({ id: 'synthetic.12345678', state: UNKNOWN }),
    transmit: request => {
      boundary.notice = { ...request, state: previous ? OPEN : UNKNOWN };
      (boundary.noticeAttempts ??= []).push(request.id);
      writeFileSync(path, JSON.stringify(boundary));
      return boundary.notice;
    },
  };
  await reconcileHuman({ doors, now: Date.now() + (previous ? DOOR_RETRY_MS : 0), onError: (_id, error) => { throw error; } });
}

const [operation] = process.argv.slice(2);
const worker = workers()[0];
const terminals = allTerminals();
if (operation === 'serve') {
  const logFailure = (_subject, error) => { throw error; };
  serveQueue(terminals, logFailure, createAdmission({ logFailure, readText: healthyWorkerMemory }));
} else if (operation === 'relay') await relayNotice();
else if (operation === 'register') save(JSON.parse(readFileSync(0, 'utf8')));
else if (operation === 'runtime-wait') {
  const waitingSince = Number(readFileSync(0, 'utf8'));
  writePrivateJson(statePath(worker), { ...lifecycleOf(worker), phase: 'waiting', waitingSince });
} else if (['settle', 'receive'].includes(operation)) {
  const sessionFile = worker.sessionFile ?? `${worker.sessionDir}/synthetic.jsonl`;
  const context = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'synthetic-session',
    getLeafId: () => 'final-leaf', getBranch: () => readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) } };
  const runtime = new WorkerRuntime({ events: { emit(_event, request) { request.result = { version: 1, asyncRuns: 0, waitSubscriptions: 0, awaited: 0 }; } } }, worker);
  process.env.HC_TERMINAL_ID = worker.terminal;
  if (operation === 'receive') runtime.input({ text: readFileSync(0, 'utf8') }, context);
  else runtime.settle(context);
  runtime.stop();
} else if (operation === 'inspect') {
  inspectWorker(worker, { terminals, now: Date.now() + SETTLED_GRACE_MS, queue: queued(), pending: new Set() });
} else if (operation === 'report') reportTasks(terminals);
else throw new Error('Unknown synthetic worker operation.');
