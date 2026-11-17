import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, watch } from 'node:fs';
import { command } from './run.mjs';
import { allTerminals } from './workers.mjs';
import { queued } from './queue.mjs';
import { canFinish, followUp, hasFinalReply, hasUncollectedHelpers, LIFECYCLE, lifecyclePath, readLifecycle, resultId, SETTLED_GRACE_MS, writeLifecycle } from './worker-lifecycle.mjs';

const WORK_CONTRACTS = { 'pi-subagents:active-work:v1': ['asyncRuns', 'waitSubscriptions'], 'pi-guard:bash-jobs:v1': ['awaited'] };
const PROTOCOL_VERSION = 1;

function hasNoPendingWork(pi) {
  return Object.entries(WORK_CONTRACTS).every(([event, fields]) => {
    const request = { version: PROTOCOL_VERSION };
    pi.events.emit(event, request);
    return request.result?.version === PROTOCOL_VERSION && fields.every(field => request.result[field] === 0);
  });
}

export class WorkerRuntime {
  #worker;
  #pi;
  #state;
  #received = new Set();
  #observer;
  #timer;
  #removeInput;

  constructor(pi, worker) {
    this.#pi = pi;
    this.#worker = worker;
  }

  #publish(context, phase) {
    this.#state = { ...this.#worker, terminal: process.env.HC_TERMINAL_ID,
      sessionFile: context.sessionManager.getSessionFile(), sessionId: context.sessionManager.getSessionId(),
      leaf: context.sessionManager.getLeafId(), generation: randomUUID(), phase, received: [...this.#received],
      ...(phase === 'settled' && { settledAt: Date.now() }) };
    writeLifecycle(lifecyclePath(this.#worker), this.#state);
  }

  invalidate(context) {
    clearTimeout(this.#timer);
    rmSync(lifecyclePath(this.#worker, 'receipt'), { force: true });
    this.#publish(context, 'active');
  }

  start(context) {
    mkdirSync(LIFECYCLE, { recursive: true });
    this.#publish(context, 'starting');
    this.#observer = watch(LIFECYCLE, (_event, file) => {
      if (`${file}` === `${this.#worker.name}-${this.#worker.launchId}.receipt`) this.finish(context);
    });
    this.#removeInput = context.ui.onTerminalInput(() => this.invalidate(context));
  }

  input(event, context) {
    const message = followUp(event.text);
    if (message.id) this.#received.add(message.id);
    this.invalidate(context);
    return message.id ? { action: 'transform', text: message.text, images: event.images } : { action: 'continue' };
  }

  settle(context) {
    this.invalidate(context);
    if (hasFinalReply(context.sessionManager.getBranch()) && hasNoPendingWork(this.#pi)) this.#publish(context, 'settled');
  }

  finish(context) {
    try {
      const receipt = readLifecycle(lifecyclePath(this.#worker, 'receipt'));
      if (!this.#state || receipt?.id !== resultId(this.#state)) return;
      const due = this.#state.settledAt + SETTLED_GRACE_MS - Date.now();
      if (due > 0) {
        this.#timer = setTimeout(() => this.finish(context), due);
        return;
      }
      if (!this.#canClose(context)) return;
      this.#publish(context, 'closing');
      context.shutdown();
    } catch (error) {
      process.stderr.write(`pots lifecycle: close deferred: ${error instanceof Error ? error.message : 'inspection failed'}\n`);
    }
  }

  #canClose(context) {
    if (!context.isIdle() || context.hasPendingMessages() || context.ui.getEditorText().trim()) return false;
    if (queued().some(request => request.worker === this.#worker.name)) return false;
    if (context.sessionManager.getLeafId() !== this.#state.leaf || !hasFinalReply(context.sessionManager.getBranch()) || !hasNoPendingWork(this.#pi)) return false;
    const terminals = allTerminals();
    const terminal = terminals.find(candidate => candidate.address === this.#state.terminal);
    if (!terminal || !canFinish(this.#state, terminal, Date.now()) || hasUncollectedHelpers(terminal, terminals)) return false;
    const options = { cwd: context.cwd };
    if (command('git', ['status', '--porcelain'], options)) return false;
    return command('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], options) === '0';
  }

  stop() {
    clearTimeout(this.#timer);
    this.#observer?.close();
    this.#removeInput?.();
  }
}
