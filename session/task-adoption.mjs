import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readConversation } from './adopted-execution.mjs';
import { completionFacts, isPublished } from './worker-lifecycle.mjs';
import { keepResult } from './worker-results.mjs';
import { hasFinalReply } from './worker-runtime.mjs';
import { botId } from './sandbox.mjs';
import { acceptedTask, associatedWorker, isTaskText, TASK_TEXT_BYTES } from './tasks.mjs';
import { taskLock } from './task-store.mjs';
import { selectedExecution } from './task-selection.mjs';
import { taskView } from './task-view.mjs';
import { allTerminals, save, terminalName, terminalOf, workers } from './workers.mjs';

export function adoptTask({ id, selection, ...unexpected }) {
  if (Object.keys(unexpected).length) throw new Error('task: adoption accepts only id and backend-issued selection.');
  return taskLock(() => {
    const record = acceptedTask(id);
    const { terminals, terminal, adoption } = selectedExecution(record, selection);
    const address = terminal.address;
    const known = associatedWorker(id);
    if (known) {
      if (!terminalOf(known, [terminal])) throw new Error('task: already associated with a different or changed execution. Inspect its worker.');
      return taskView(record, workers(), terminals);
    }
    if (workers().some(worker => worker.terminal === address)) throw new Error('task: execution already has a worker. Associate that worker explicitly.');
    const name = terminalName(`pots-adopt-${id}`);
    if (workers().some(worker => worker.name === name)) throw new Error('task: adoption worker name collides. Choose a different task identity.');
    save({ name, owner: botId, taskId: id, launchId: `adopt-${id}`, adoption, terminal: address,
      worktree: adoption.worktree, sessionFile: adoption.sessionFile, sessionId: adoption.sessionId, createdAt: Date.now() });
    return taskView(record, workers(), terminals);
  });
}

export function recordAdoptedResult({ id, sessionDigest, summary, ...unexpected }) {
  if (Object.keys(unexpected).length || !isTaskText(summary)) {
    throw new Error(`task: result accepts id, exact sessionDigest and a nonempty coordinator summary of at most ${TASK_TEXT_BYTES} bytes without NUL.`);
  }
  return taskLock(() => {
    const record = acceptedTask(id);
    const worker = associatedWorker(id);
    if (!worker?.adoption) throw new Error('task: managed workers publish their result through the existing lifecycle.');
    if (worker.result) {
      if (worker.result.sessionDigest !== sessionDigest || worker.result.summary !== summary) throw new Error('task: adopted outcome is final. Follow up with the coordinator.');
      return taskView(record, workers(), allTerminals());
    }
    const conversation = readConversation(worker.sessionFile);
    const digest = createHash('sha256').update(conversation.content).digest('hex');
    if (digest !== sessionDigest || conversation.id !== worker.sessionId) throw new Error('task: conversation changed. Read its exact final report and submit the current digest.');
    const branch = conversation.content.trim().split('\n').map(line => JSON.parse(line));
    if (!hasFinalReply(branch)) throw new Error('task: conversation needs a final assistant reply with no open goal before coordinator attestation.');
    const terminals = allTerminals();
    const terminal = terminalOf(worker, terminals);
    if (!terminal) throw new Error('task: original execution is absent or changed. Disappearance never proves completion.');
    if (!['idle', 'done'].includes(terminal.status)) throw new Error('task: execution is still working or blocked. Read its final report first.');
    if (!isPublished(completionFacts(worker))) throw new Error('task: worktree must be clean and published before recording its final outcome.');
    const state = { name: worker.name, owner: botId, launchId: worker.launchId, terminal: worker.terminal, sessionFile: worker.sessionFile,
      sessionId: worker.sessionId, sessionDigest: digest, summary, kind: 'coordinator-attestation' };
    const result = { ...keepResult(worker, terminal, state), sessionDigest: digest, summary, kind: state.kind };
    if (createHash('sha256').update(readFileSync(result.transcript)).digest('hex') !== digest) throw new Error('task: conversation changed during collection. Inspect it and retry its current digest.');
    save({ ...worker, result });
    return taskView(record, workers(), terminals);
  });
}
