import { randomUUID } from 'node:crypto';
import { rmSync, watch } from 'node:fs';
import { join } from 'node:path';
import { allTerminals } from './workers.mjs';
import { hasQueued } from './queue.mjs';
import { canFinish, followUp, isPublished, LIFECYCLE, publication, receiptPath, resultId, statePath } from './worker-lifecycle.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

const WORK_CONTRACTS = { 'pi-subagents:active-work:v1': ['asyncRuns', 'waitSubscriptions'], 'pi-guard:bash-jobs:v1': ['awaited'] };
const PROTOCOL_VERSION = 1;

function hasOpenGoal(branch) {
  const goal = branch.findLast(entry => entry.type === 'custom' && entry.customType === 'pi-goal-state-v1');
  if (!goal) return false;
  const { blocked, items, paused = [] } = goal.data;
  return [Boolean(blocked), items.some(item => !item.done), paused.length > 0].some(Boolean);
}

function isFinalMessage({ message = {} }) {
  const content = Array.isArray(message.content) ? message.content : [];
  return [message.role === 'assistant', message.stopReason === 'stop', content.some(part => part.type === 'text' && part.text.trim())].every(Boolean);
}

export function hasFinalReply(branch) {
  if (hasOpenGoal(branch)) return false;
  const entry = branch.findLast(candidate => candidate.type === 'message');
  return Boolean(entry && isFinalMessage(entry));
}

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
    writePrivateJson(statePath(this.#worker), this.#state);
  }

  invalidate(context) {
    rmSync(receiptPath(this.#worker), { force: true });
    this.#publish(context, 'active');
  }

  start(context) {
    this.#publish(context, 'starting');
    this.#observer = watch(LIFECYCLE, (_event, file) => {
      if (join(LIFECYCLE, `${file}`) === receiptPath(this.#worker)) this.finish(context);
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
    if (this.#isDone(context)) this.#publish(context, 'settled');
  }

  finish(context) {
    try {
      this.#closeWhenFinished(context);
    } catch (error) {
      process.stderr.write(`pots lifecycle: close deferred: ${error instanceof Error ? error.message : 'inspection failed'}\n`);
    }
  }

  #hasReceipt() {
    const receipt = readJson(receiptPath(this.#worker));
    return this.#state && receipt?.id === resultId(this.#state);
  }

  #closeWhenFinished(context) {
    if (!this.#hasReceipt() || !this.#canClose(context)) return;
    this.#publish(context, 'closing');
    context.shutdown();
  }

  #isDone(context) {
    return hasFinalReply(context.sessionManager.getBranch()) && hasNoPendingWork(this.#pi);
  }

  #hasFinishedSession(context) {
    return [context.isIdle(), !context.hasPendingMessages(), !context.ui.getEditorText().trim(),
      context.sessionManager.getLeafId() === this.#state.leaf, this.#isDone(context)].every(Boolean);
  }

  #canClose(context) {
    if (!this.#hasFinishedSession(context)) return false;
    if (hasQueued(this.#worker.name)) return false;
    const terminals = allTerminals();
    const terminal = terminals.find(candidate => candidate.address === this.#state.terminal);
    if (!terminal) return false;
    return [canFinish(this.#state, terminal, terminals, Date.now()), isPublished(publication(context.cwd))].every(Boolean);
  }

  stop() {
    this.#observer?.close();
    this.#removeInput?.();
  }
}
