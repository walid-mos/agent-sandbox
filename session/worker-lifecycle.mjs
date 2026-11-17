import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKERS } from './workers.mjs';

export const LIFECYCLE = join(WORKERS, 'lifecycle');
export const SETTLED_GRACE_MS = 5000;
const MESSAGE_PREFIX = '<pots-follow-up id="';
const MESSAGE_SEPARATOR = '">\n';
const MESSAGE_SUFFIX = '\n</pots-follow-up>';

export function lifecyclePath(worker, suffix = 'json') {
  return join(LIFECYCLE, `${worker.name}-${worker.launchId}.${suffix}`);
}

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
  const state = readLifecycle(lifecyclePath(worker));
  if (state?.launchId !== worker.launchId || state.owner !== worker.owner || state.name !== worker.name) return undefined;
  return state;
}

export const resultId = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');

export function wrappedFollowUp(request) {
  return `${MESSAGE_PREFIX}${request.file}${MESSAGE_SEPARATOR}${request.message}${MESSAGE_SUFFIX}`;
}

export function followUp(text) {
  const envelope = /^(<hc\b[^>]*>)([\s\S]*)(<\/hc>)$/.exec(text);
  const body = envelope?.[2] ?? text;
  if (!body.startsWith(MESSAGE_PREFIX) || !body.endsWith(MESSAGE_SUFFIX)) return { text };
  const separator = body.indexOf(MESSAGE_SEPARATOR, MESSAGE_PREFIX.length);
  if (separator < 0) return { text };
  const id = body.slice(MESSAGE_PREFIX.length, separator);
  if (!/^[a-zA-Z0-9.-]+\.json$/.test(id)) return { text };
  const message = body.slice(separator + MESSAGE_SEPARATOR.length, -MESSAGE_SUFFIX.length);
  return { id, text: envelope ? `${envelope[1]}${message}${envelope[3]}` : message };
}

export function hasFinalReply(branch) {
  const message = branch.findLast(entry => entry.type === 'message')?.message;
  const goal = branch.findLast(entry => entry.type === 'custom' && entry.customType === 'pi-goal-state-v1')?.data;
  if (goal && (goal.blocked || goal.items?.some(item => !item.done) || goal.paused?.length)) return false;
  return message?.role === 'assistant' && message.stopReason === 'stop' &&
    message.content?.some(part => part.type === 'text' && part.text.trim());
}

export function hasUncollectedHelpers(terminal, terminals) {
  return terminals.some(helper => {
    if (helper.address === terminal.address) return false;
    if (helper.parent !== terminal.address && helper.cwd !== terminal.cwd) return false;
    if (helper.state === 'live') return true;
    const readAt = Number(helper.labels?.[`agent.read.${terminal.address}`]);
    return !helper.finished_ms || !readAt || readAt < helper.finished_ms;
  });
}

export function canFinish(state, terminal, now) {
  if (!state || state.phase !== 'settled' || !Number.isFinite(state.settledAt) || now < state.settledAt + SETTLED_GRACE_MS) return false;
  if (terminal.address !== state.terminal || terminal.labels?.['pots.launch'] !== state.launchId || terminal.labels?.['pots.owner'] !== state.owner) return false;
  const status = typeof terminal.status === 'string' ? terminal.status : terminal.status?.state;
  return terminal.state === 'live' && ['done', 'idle'].includes(status) &&
    !terminal.labels?.['agent.waiting'] && !terminal.labels?.['agent.goal'] && !terminal.labels?.['lifecycle.keep'];
}
