import { randomUUID } from 'node:crypto';
import { rmSync, watch } from 'node:fs';
import { basename } from 'node:path';
import { allTerminals } from './workers.mjs';
import { hasQueued } from './queue.mjs';
import { canFinish, followUp, isPublished, LIFECYCLE, publication, receiptPath, resultId, statePath } from './worker-lifecycle.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

const WORK_CONTRACTS = { 'pi-subagents:active-work:v1': ['asyncRuns', 'waitSubscriptions'], 'pi-guard:bash-jobs:v1': ['awaited'] };
const PROTOCOL_VERSION = 1;
const CLOSE_ATTEMPTS = 3;
const CLOSE_RETRY_MS = 1000;

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

function workCounts(pi) {
  return Object.entries(WORK_CONTRACTS).map(([event, fields]) => {
    const request = { version: PROTOCOL_VERSION };
    pi.events.emit(event, request);
    return request.result?.version === PROTOCOL_VERSION ? fields.map(field => request.result[field]) : undefined;
  });
}

// Missing contracts prevent closure but cannot justify delaying a report.
const hasNoPendingWork = pi => workCounts(pi).every(counts => counts?.every(count => count === 0));
const hasRunningWork = pi => workCounts(pi).some(counts => counts?.some(count => Number.isSafeInteger(count) && count > 0));

export class WorkerRuntime {
  #worker;
  #pi;
  #state;
  #received = new Set();
  #observer;
  #removeInput;
  #closeAttempt;
  #closeTimer;

  constructor(pi, worker) {
    this.#pi = pi;
    this.#worker = worker;
  }

  #publish(context, phase) {
    this.#state = { ...this.#worker, terminal: process.env.HC_TERMINAL_ID,
      sessionFile: context.sessionManager.getSessionFile(), sessionId: context.sessionManager.getSessionId(),
      leaf: context.sessionManager.getLeafId(), generation: randomUUID(), phase, received: [...this.#received],
      ...(phase === 'settled' && { settledAt: Date.now() }), ...(phase === 'waiting' && { waitingSince: Date.now() }) };
    writePrivateJson(statePath(this.#worker), this.#state);
  }

  invalidate(context) {
    this.#cancelClose();
    rmSync(receiptPath(this.#worker), { force: true });
    this.#publish(context, 'active');
  }

  start(context) {
    this.#publish(context, 'starting');
    const receipt = basename(receiptPath(this.#worker));
    this.#observer = watch(LIFECYCLE, (_event, file) => {
      if (`${file}` === receipt) this.finish(context);
    });
    // Only a published result can be invalidated, so input on an active session writes nothing and starts no watcher pass.
    this.#removeInput = context.ui.onTerminalInput(() => {
      if (this.#state?.phase !== 'active') this.invalidate(context);
    });
  }

  input(event, context) {
    const message = followUp(event.text);
    if (message.id) this.#received.add(message.id);
    this.invalidate(context);
    return message.id ? { action: 'transform', text: message.text, images: event.images } : { action: 'continue' };
  }

  settle(context) {
    this.invalidate(context);
    if (hasRunningWork(this.#pi)) this.#publish(context, 'waiting');
    else if (this.#isDone(context)) this.#publish(context, 'settled');
  }

  finish(context) {
    if (this.#closeTimer) return;
    try {
      if (!this.#hasReceipt()) return this.#cancelClose();
      const id = resultId(this.#state);
      if (this.#closeAttempt?.id !== id) this.#closeAttempt = { id, attempts: 0 };
      if (this.#closeAttempt.attempts >= CLOSE_ATTEMPTS) return;
      this.#closeAttempt.attempts += 1;
      this.#closeWhenFinished(context);
    } catch (error) {
      process.stderr.write(`pots lifecycle: close deferred: ${error instanceof Error ? error.message : 'inspection failed'}\n`);
      this.#retryClose(context);
    }
  }

  #retryClose(context) {
    if (!this.#closeAttempt || this.#closeAttempt.attempts >= CLOSE_ATTEMPTS) return;
    this.#closeTimer = setTimeout(() => {
      this.#closeTimer = undefined;
      this.finish(context);
    }, CLOSE_RETRY_MS);
    this.#closeTimer.unref();
  }

  #cancelClose() {
    clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
    this.#closeAttempt = undefined;
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
    return canFinish(this.#state, terminal, terminals, Date.now()) && isPublished(publication(context.cwd));
  }

  stop() {
    this.#cancelClose();
    this.#observer?.close();
    this.#removeInput?.();
  }
}
