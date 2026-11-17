import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJson } from './private-json.mjs';
import { isRequestName } from './queue.mjs';
import { command } from './run.mjs';
import { isLive, ownsTerminal, WORKERS } from './workers.mjs';

export const LIFECYCLE = join(WORKERS, 'lifecycle');
export const SETTLED_GRACE_MS = 5000;
const MESSAGE_PREFIX = '<pots-follow-up id="';
const MESSAGE_SEPARATOR = '">\n';
const MESSAGE_SUFFIX = '\n</pots-follow-up>';

const lifecycleFile = (worker, suffix) => join(LIFECYCLE, `${worker.name}-${worker.launchId}.${suffix}`);
export const statePath = worker => lifecycleFile(worker, 'json');
export const receiptPath = worker => lifecycleFile(worker, 'receipt');

export function lifecycleOf(worker) {
  if (!worker.launchId) return undefined;
  const state = readJson(statePath(worker));
  if (!state) return undefined;
  if (![state.launchId === worker.launchId, state.owner === worker.owner, state.name === worker.name].every(Boolean)) return undefined;
  return state;
}

export function publication(cwd) {
  const options = { cwd };
  return {
    uncommitted: command('git', ['status', '--porcelain'], options).split('\n').filter(Boolean).length,
    unpushed: Number(command('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], options)),
  };
}

export const isPublished = ({ uncommitted, unpushed }) => uncommitted === 0 && unpushed === 0;

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
  if (!isRequestName(id)) return {};
  return { id, message: body.slice(separator + MESSAGE_SEPARATOR.length, -MESSAGE_SUFFIX.length) };
}

export function followUp(text) {
  const [, prefix = '', body = text, suffix = ''] = /^(<hc\b[^>]*>)([\s\S]*)(<\/hc>)$/.exec(text) ?? [];
  const { id, message } = parsedFollowUp(body);
  if (!id) return { text };
  return { id, text: `${prefix}${message}${suffix}` };
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
  return [state.phase === 'settled', now >= readyAt(state),
    terminal.address === state.terminal, ownsTerminal(state, terminal), isLive(terminal), ['done', 'idle'].includes(terminal.status),
    !labels['agent.waiting'], !labels['agent.goal'], !labels['lifecycle.keep'], !hasUncollectedHelpers(terminal, terminals)].every(Boolean);
}
