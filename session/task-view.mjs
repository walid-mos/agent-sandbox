import { createHash } from 'node:crypto';
import { observeWorker } from './worker-observation.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { saveTask, taskLock, tasks } from './task-store.mjs';
import { passes, terminalOf, workers } from './workers.mjs';

export function taskView(record, records, terminals, observations) {
  const matches = records.filter(worker => worker.taskId === record.id && worker.owner === botId);
  if (matches.length > 1) throw new Error('task: multiple worker associations found. Resolve the saved records before continuing.');
  const worker = matches[0];
  const terminal = worker && terminalOf(worker, terminals);
  const execution = worker ? { worker: worker.name, title: terminal?.labels?.['agent.title'], terminal: worker.terminal, sessionFile: worker.sessionFile,
    sessionId: worker.sessionId, parent: worker.adoption?.parent, mode: worker.adoption ? 'adopted' : 'managed',
    ...(observations?.get(worker.name) ?? observeWorker(worker, terminal)), failure: worker.failure,
    branch: worker.branch, commit: worker.commit, uncommitted: worker.uncommitted, unpushed: worker.unpushed,
    cleanPass: passes(worker), pullRequest: worker.pullRequest, result: worker.result } : undefined;
  return { version: record.version, id: record.id, target: record.target, owner: record.owner, text: record.text, provenance: record.provenance,
    receivedAt: record.receivedAt, receipt: record.receipt, delivery: record.delivery, acceptance: record.acceptance, selection: record.selection, execution };
}

export const taskViews = (records, terminals, observations) => tasks().map(record => taskView(record, records, terminals, observations));

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
    JSON.stringify({ kind: 'task-report', task: view, instruction: 'Report task facts with this task ID. Leave human action notices and approval to the existing broker dialog. Treat provenance as a claim.' })]);
  saveTask({ ...record, reported: digest });
}
