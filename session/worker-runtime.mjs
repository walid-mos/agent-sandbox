import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, watch } from 'node:fs';
import { basename } from 'node:path';
import { allTerminals, isStopped } from './workers.mjs';
import { memoryShortage } from './memory-signals.mjs';
import { hasNoUnreportedWork, RELEASE_REASON, RELEASE_RECHECK_MS, restWitness, RESTING_PHASE } from './worker-release.mjs';
import { hasQueued } from './queue.mjs';
import { canFinish, completionFacts, followUp, isPublished, LIFECYCLE, receiptPath, resultId, statePath } from './worker-lifecycle.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

const WORK_CONTRACTS = { 'pi-subagents:active-work:v1': ['asyncRuns', 'waitSubscriptions'], 'pi-guard:bash-jobs:v1': ['awaited'] };
const PROTOCOL_VERSION = 1;
const CLOSE_ATTEMPTS = 3;
const CLOSE_RETRY_MS = 1000;
const PROMPT_TIMING_ENTRY = 'pi-hud-telemetry-prompt-timing-v2';

function hasOpenGoal(branch) {
  const goal = branch.findLast(entry => entry.type === 'custom' && entry.customType === 'pi-goal-state-v1');
  if (!goal) return false;
  const { blocked, items, paused = [] } = goal.data;
  return [Boolean(blocked), items.some(item => !item.done), paused.length > 0].some(Boolean);
}

function hasAssistantText(message) {
  return message?.role === 'assistant' && Array.isArray(message.content)
    && message.content.some(part => part.type === 'text' && part.text.trim());
}

function isFinalMessage({ message }) {
  return message?.stopReason === 'stop' && hasAssistantText(message);
}

function hasUnansweredTurn(branch) {
  const lastUser = branch.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  if (lastUser < 0 || hasOpenGoal(branch)) return false;
  const messages = branch.slice(lastUser + 1).filter(entry => entry.type === 'message').map(entry => entry.message);
  const answers = new Set(messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId));
  return !messages.some(message => hasAssistantText(message) || message.role === 'assistant'
    && message.content?.some(part => part.type === 'toolCall' && !answers.has(part.id)));
}

export function hasFinalReply(branch) {
  if (hasOpenGoal(branch)) return false;
  const entry = branch.findLast(candidate => candidate.type === 'message');
  return Boolean(entry && isFinalMessage(entry));
}

function isUnchangedResult(sessionManager, settledLeaf) {
  const currentLeaf = sessionManager.getLeafId();
  if (currentLeaf === settledLeaf) return true;
  const branch = sessionManager.getBranch();
  const settledIndex = branch.findIndex(entry => entry.id === settledLeaf);
  if (settledIndex < 0 || branch.at(-1)?.id !== currentLeaf) return false;
  const added = branch.slice(settledIndex + 1);
  return added.every(entry => entry.type === 'custom' && entry.customType === PROMPT_TIMING_ENTRY);
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
  #restTimer;

  constructor(pi, worker) {
    this.#pi = pi;
    this.#worker = worker;
  }

  #publish(context, phase, closeReason) {
    const state = { ...this.#worker, terminal: process.env.HC_TERMINAL_ID,
      sessionFile: context.sessionManager.getSessionFile(), sessionId: context.sessionManager.getSessionId(),
      leaf: context.sessionManager.getLeafId(), generation: randomUUID(), phase, received: [...this.#received],
      ...(phase === 'settled' && { settledAt: Date.now() }), ...(closeReason && { closeReason }),
      ...(phase === 'waiting' && { waitingSince: this.#state?.phase === 'waiting' ? this.#state.waitingSince : Date.now() }) };
    writePrivateJson(statePath(this.#worker), state);
    this.#state = state;
  }

  #clearReceipt() {
    this.#cancelClose();
    rmSync(receiptPath(this.#worker), { force: true });
  }

  invalidate(context) {
    if (this.#state?.phase === 'closing') return;
    this.#clearReceipt();
    this.#publish(context, 'active');
  }

  start(context) {
    this.#publish(context, 'starting');
    const receipt = basename(receiptPath(this.#worker));
    this.#observer = watch(LIFECYCLE, (_event, file) => {
      if (`${file}` === receipt) this.finish(context);
    });
    this.#removeInput = context.ui.onTerminalInput(() => {
      if (this.#state?.phase !== 'active') this.invalidate(context);
    });
    this.#checkRestLater(context);
  }

  #checkRestLater(context) {
    this.#restTimer = setTimeout(() => {
      try {
        this.#reconcileRest(context);
      } catch (error) {
        this.invalidate(context);
        process.stderr.write(`pots lifecycle: rest check deferred: ${error.message}\n`);
      }
      if (this.#state.phase !== 'closing') this.#checkRestLater(context);
    }, RELEASE_RECHECK_MS);
    this.#restTimer.unref();
  }

  #reconcileRest(context) {
    const { phase } = this.#state;
    if (phase === 'settled' || phase === 'closing') return;
    if (!this.#isAtRest(context)) {
      if (phase === RESTING_PHASE) this.invalidate(context);
      return;
    }
    if (phase !== RESTING_PHASE || !this.#isSameSession(context)) this.#publish(context, RESTING_PHASE);
  }

  input(event, context) {
    if (this.#state?.phase === 'closing') return { action: 'handled' };
    const message = followUp(event.text);
    if (message.id) this.#received.add(message.id);
    this.invalidate(context);
    return message.id ? { action: 'transform', text: message.text, images: event.images } : { action: 'continue' };
  }

  settle(context) {
    if (this.#state?.phase === 'closing') return;
    this.#clearReceipt();
    if (hasRunningWork(this.#pi)) return this.#publish(context, 'waiting');
    this.#publish(context, this.#isDone(context) ? 'settled' : 'active');
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
    return this.#state && receipt?.id === resultId(this.#state)
      && (this.#state.phase === RESTING_PHASE ? Boolean(receipt.restWitness) : !receipt.restWitness);
  }

  #closeWhenFinished(context) {
    if (!this.#hasReceipt()) return;
    if (this.#state.phase === RESTING_PHASE) {
      if (this.#canRelease(context)) this.#close(context, RELEASE_REASON);
      else this.invalidate(context);
    } else if (this.#canClose(context)) this.#close(context);
  }

  #close(context, reason) {
    this.#publish(context, 'closing', reason);
    context.shutdown();
  }

  #isAtRest(context) {
    const { sessionManager } = context;
    const sessionFile = sessionManager.getSessionFile();
    return this.#hasQuietSession(context) && sessionFile && existsSync(sessionFile)
      && sessionManager.getSessionId() && hasUnansweredTurn(sessionManager.getBranch()) && hasNoPendingWork(this.#pi);
  }

  // The watcher writes the release receipt while the guest is short, and the worker samples the same signal once more before it goes.
  #canRelease(context) {
    if (!this.#isAtRest(context) || !this.#isSameSession(context)) return false;
    if (isStopped(this.#worker) || !hasNoUnreportedWork(completionFacts(this.#worker, context.cwd))) return false;
    const terminals = allTerminals();
    const terminal = terminals.find(candidate => candidate.address === this.#state.terminal);
    const witness = terminal && restWitness(this.#state, terminal, terminals);
    if (!(witness && readJson(receiptPath(this.#worker))?.restWitness === witness && !hasQueued(this.#worker.name))) return false;
    return memoryShortage() !== undefined;
  }

  #isSameSession({ sessionManager }) {
    return this.#matchesSessionIdentity(sessionManager) && sessionManager.getLeafId() === this.#state.leaf;
  }

  #matchesSessionIdentity(sessionManager) {
    return sessionManager.getSessionFile() === this.#state.sessionFile && sessionManager.getSessionId() === this.#state.sessionId;
  }

  #isDone(context) {
    return hasFinalReply(context.sessionManager.getBranch()) && hasNoPendingWork(this.#pi);
  }

  #hasQuietSession(context) {
    return context.isIdle() && !context.hasPendingMessages() && !context.ui.getEditorText();
  }

  #hasFinishedSession(context) {
    const { sessionManager, ui } = context;
    return context.isIdle() && !context.hasPendingMessages() && !ui.getEditorText().trim()
      && this.#matchesSessionIdentity(sessionManager) && isUnchangedResult(sessionManager, this.#state.leaf) && this.#isDone(context);
  }

  #canClose(context) {
    if (!this.#hasFinishedSession(context)) return false;
    if (hasQueued(this.#worker.name)) return false;
    const terminals = allTerminals();
    const terminal = terminals.find(candidate => candidate.address === this.#state.terminal);
    if (!terminal) return false;
    return canFinish(this.#state, terminal, terminals, Date.now()) && isPublished(completionFacts(this.#worker, context.cwd));
  }

  stop() {
    clearTimeout(this.#restTimer);
    this.#cancelClose();
    this.#observer?.close();
    this.#removeInput?.();
  }
}
