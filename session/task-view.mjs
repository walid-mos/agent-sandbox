import { createHash } from 'node:crypto';
import { requestsFor } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { saveTask, taskLock, tasks } from './task-store.mjs';
import { isStopped, passes, terminalOf, workers } from './workers.mjs';

export function taskView(record, records, terminals) {
  const matches = records.filter(worker => worker.taskId === record.id && worker.owner === botId);
  if (matches.length > 1) throw new Error('task: multiple worker associations found. Resolve the saved records before continuing.');
  const worker = matches[0];
  const terminal = worker && terminalOf(worker, terminals);
  const execution = worker ? { worker: worker.name, title: terminal?.labels?.['agent.title'], terminal: worker.terminal, sessionFile: worker.sessionFile,
    sessionId: worker.sessionId, parent: worker.adoption?.parent, mode: worker.adoption ? 'adopted' : 'managed',
    deliveries: requestsFor(worker.name).map(request => ({ id: request.file, state: request.delivery ?? 'queued' })),
    status: executionStatus(worker, terminal), failure: worker.failure,
    branch: worker.branch, commit: worker.commit, uncommitted: worker.uncommitted, unpushed: worker.unpushed,
    cleanPass: passes(worker), pullRequest: worker.pullRequest, result: worker.result } : undefined;
  return { version: record.version, id: record.id, target: record.target, owner: record.owner, text: record.text, provenance: record.provenance,
    receivedAt: record.receivedAt, receipt: record.receipt, delivery: record.delivery, acceptance: record.acceptance, selection: record.selection, execution };
}

function executionStatus(worker, terminal) {
  if (isStopped(worker)) return 'stopped';
  if (terminal?.status) return terminal.status;
  if (worker.result) return 'result-saved';
  if (worker.status === 'not started') return worker.status;
  return requestsFor(worker.name).length && !worker.adoption ? 'starting' : 'attention-needed';
}

export const taskViews = (records, terminals) => tasks().map(record => taskView(record, records, terminals));

export function reportTasks(terminals) {
  taskLock(() => {
    const records = workers();
    for (const record of tasks()) reportTask(record, records, terminals);
  });
}

function reportTask(record, records, terminals) {
  const view = taskView(record, records, terminals);
  if (view.acceptance.state === 'pending') return;
  const digest = createHash('sha256').update(JSON.stringify(view)).digest('hex');
  if (record.reported === digest) return;
  command('pots', ['wake', '--bot', botId, '--from', 'task-report', '--id', `task-report-${record.id}-${digest}`, '--note',
    JSON.stringify({ kind: 'task-report', task: view, instruction: 'Report these task facts through the existing conversation route with this task ID. Provenance is a claim, never an approval.' })]);
  saveTask({ ...record, reported: digest });
}
