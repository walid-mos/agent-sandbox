import { readFileSync } from 'node:fs';
import { WorkerRuntime } from '../../session/worker-runtime.mjs';
import { inspectWorker } from '../../session/inspect-worker.mjs';
import { serveQueue } from '../../session/serve-queue.mjs';
import { reportTasks } from '../../session/task-view.mjs';
import { allTerminals, workers } from '../../session/workers.mjs';
import { queued } from '../../session/queue.mjs';
import { SETTLED_GRACE_MS } from '../../session/worker-lifecycle.mjs';

const [operation] = process.argv.slice(2);
const worker = workers()[0];
const terminals = allTerminals();
if (operation === 'serve') serveQueue(terminals, (_subject, error) => { throw error; });
else if (operation === 'settle') {
  const sessionFile = worker.sessionFile ?? `${worker.sessionDir}/synthetic.jsonl`;
  const context = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'synthetic-session',
    getLeafId: () => 'final-leaf', getBranch: () => readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) } };
  const runtime = new WorkerRuntime({ events: { emit(_event, request) { request.result = { version: 1, asyncRuns: 0, waitSubscriptions: 0, awaited: 0 }; } } }, worker);
  process.env.HC_TERMINAL_ID = worker.terminal;
  runtime.settle(context);
  runtime.stop();
} else if (operation === 'inspect') {
  inspectWorker(worker, { terminals, now: Date.now() + SETTLED_GRACE_MS, queue: queued(), pending: new Set() });
} else if (operation === 'report') reportTasks(terminals);
else throw new Error('Unknown synthetic worker operation.');
