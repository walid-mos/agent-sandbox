import { requestsFor } from './queue.mjs';
import { openWorkerDialog } from './worker-human.mjs';
import { lifecycleOf } from './worker-lifecycle.mjs';
import { isLive, isStopped } from './workers.mjs';

function observeDelivery(request, state) {
  const { file: id, sentTo } = request;
  if (state?.received?.includes(id)) return { id, sentTo, state: 'received' };
  if (sentTo) return { id, sentTo, state: 'sent' };
  return { id, state: request.delivery ?? 'queued' };
}

function observeWait(worker, terminal, lifecycle) {
  if (!terminal) return undefined;
  const dialog = openWorkerDialog(worker, terminal);
  if (dialog) return { kind: 'human', owner: worker.owner, dialog: dialog.id, startedAt: dialog.createdAt,
    action: dialog.kind, delivery: dialog.delivery && { id: dialog.delivery.id, state: dialog.delivery.state } };
  if (lifecycle?.phase === 'waiting') return { kind: 'internal', owner: worker.owner, startedAt: lifecycle.waitingSince };
  return undefined;
}

function statusOf(worker, terminal, wait, deliveries) {
  if (wait?.kind === 'human') return 'blocked';
  if (wait?.kind === 'internal') return 'waiting';
  if (terminal && ['done', 'idle'].includes(terminal.status) && deliveries.some(delivery => delivery.state !== 'received')) return 'waiting';
  if (terminal) return terminal.status ?? 'starting';
  if (worker.result) return 'result-saved';
  if (worker.failure || worker.status === 'not started') return 'not started';
  if (deliveries.length && !worker.adoption) return 'starting';
  return 'attention-needed';
}

export function observeWorker(worker, observedTerminal, lifecycle = lifecycleOf(worker)) {
  if (isStopped(worker)) return { status: 'stopped', deliveries: [] };
  const terminal = observedTerminal && isLive(observedTerminal) ? observedTerminal : undefined;
  const wait = observeWait(worker, terminal, lifecycle);
  const deliveries = requestsFor(worker.name).map(request => observeDelivery(request, lifecycle));
  const status = statusOf(worker, terminal, wait, deliveries);
  return { status, observedStatus: terminal?.status, wait, deliveries };
}
