import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLive, ownsTerminal, WORKERS } from './workers.mjs';

export const LIFECYCLE = join(WORKERS, 'lifecycle');
export const SETTLED_GRACE_MS = 5000;
const MESSAGE_PREFIX = '<pots-follow-up id="';
const MESSAGE_SEPARATOR = '">\n';
const MESSAGE_SUFFIX = '\n</pots-follow-up>';

const lifecycleFile = (worker, suffix) => join(LIFECYCLE, `${worker.name}-${worker.launchId}.${suffix}`);
export const statePath = worker => lifecycleFile(worker, 'json');
export const receiptPath = worker => lifecycleFile(worker, 'receipt');

export function writeLifecycle(path, value) {
  mkdirSync(LIFECYCLE, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function readLifecycle(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function lifecycleOf(worker) {
  if (!worker.launchId) return undefined;
  const state = readLifecycle(statePath(worker));
  if (!state) return undefined;
  if (![state.launchId === worker.launchId, state.owner === worker.owner, state.name === worker.name].every(Boolean)) return undefined;
  return state;
}

export const readyAt = state => state?.settledAt + SETTLED_GRACE_MS;

export const resultId = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');

export function wrappedFollowUp(request) {
  return `${MESSAGE_PREFIX}${request.file}${MESSAGE_SEPARATOR}${request.message}${MESSAGE_SUFFIX}`;
}

function parsedFollowUp(body) {
  const separator = body.indexOf(MESSAGE_SEPARATOR, MESSAGE_PREFIX.length);
  const isWrapped = [body.startsWith(MESSAGE_PREFIX), body.endsWith(MESSAGE_SUFFIX), separator >= 0].every(Boolean);
  if (!isWrapped) return {};
  const id = body.slice(MESSAGE_PREFIX.length, separator);
  if (!/^[a-zA-Z0-9.-]+\.json$/.test(id)) return {};
  return { id, message: body.slice(separator + MESSAGE_SEPARATOR.length, -MESSAGE_SUFFIX.length) };
}

export function followUp(text) {
  const [, prefix = '', body = text, suffix = ''] = /^(<hc\b[^>]*>)([\s\S]*)(<\/hc>)$/.exec(text) ?? [];
  const { id, message } = parsedFollowUp(body);
  if (!id) return { text };
  return { id, text: `${prefix}${message}${suffix}` };
}

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

function isUncollected(helper, reader) {
  if (isLive(helper)) return true;
  const { labels = {} } = helper;
  const readAt = Number(labels[`agent.read.${reader}`]);
  return ![helper.finished_ms > 0, readAt >= helper.finished_ms].every(Boolean);
}

export function hasUncollectedHelpers(terminal, terminals) {
  return terminals.filter(helper => helper.address !== terminal.address)
    .filter(helper => helper.parent === terminal.address || helper.cwd === terminal.cwd)
    .some(helper => isUncollected(helper, terminal.address));
}

export function canFinish(state, terminal, terminals, now) {
  if (!state) return false;
  const { labels = {} } = terminal;
  return [state.phase === 'settled', Number.isFinite(state.settledAt), now >= readyAt(state),
    terminal.address === state.terminal, ownsTerminal(state, terminal), isLive(terminal), ['done', 'idle'].includes(terminal.status),
    !labels['agent.waiting'], !labels['agent.goal'], !labels['lifecycle.keep'], !hasUncollectedHelpers(terminal, terminals)].every(Boolean);
}
