import { createHash } from 'node:crypto';
import { adoptionIdentity, localAddress } from './adopted-execution.mjs';
import { botId } from './sandbox.mjs';
import { TASK_CONTRACT_VERSION } from './task-contract.mjs';
import { saveTask, taskLock } from './task-store.mjs';
import { taskView } from './task-view.mjs';
import { acceptedTask, associatedWorker } from './tasks.mjs';
import { allTerminals, workers } from './workers.mjs';

function observeSelection(id, address) {
  localAddress(address);
  const terminals = allTerminals();
  const matches = terminals.filter(terminal => terminal.address === address);
  if (matches.length !== 1) throw new Error('task: expected exactly one local terminal at that address. Refresh and choose its exact address.');
  const terminal = matches[0];
  const adoption = adoptionIdentity(terminal);
  const identity = createHash('sha256').update(JSON.stringify({ version: TASK_CONTRACT_VERSION, owner: botId, id, adoption })).digest('hex');
  return { terminal, terminals, adoption, identity };
}

export function selectTask({ id, terminal, ...unexpected }) {
  if (Object.keys(unexpected).length) throw new Error('task: selection accepts only id and terminal. Identity metadata comes from the backend.');
  return taskLock(() => {
    const record = acceptedTask(id);
    const observed = observeSelection(id, terminal);
    const records = workers();
    if (records.some(worker => worker.terminal === terminal && worker.taskId !== id)) {
      throw new Error('task: execution already has a worker. Associate that worker before selecting an execution.');
    }
    if (record.selection && record.selection.identity !== observed.identity) {
      throw new Error('task: selected execution changed. Restore the original execution or explicitly submit a new task identity.');
    }
    if (associatedWorker(id) && !record.selection) throw new Error('task: task already has a worker. Follow up with that worker.');
    const selected = record.selection ? record : { ...record, selection: { terminal, identity: observed.identity } };
    if (!record.selection) saveTask(selected);
    return taskView(selected, records, observed.terminals);
  });
}

export function selectedExecution(record, identity) {
  if (!record.selection || typeof identity !== 'string' || identity !== record.selection.identity) {
    throw new Error('task: adoption requires the original backend-issued selection. Call task-select and retain its reply before attempting adoption.');
  }
  const observed = observeSelection(record.id, record.selection.terminal);
  if (observed.identity !== identity) throw new Error('task: selected execution changed. Restore the original execution or explicitly submit a new task identity.');
  return observed;
}
