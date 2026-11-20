import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './private-json.mjs';
import { isRequestName } from './queue.mjs';
import { command } from './run.mjs';
import { waitsForHuman } from './worker-human.mjs';
import { isLive, ownsTerminal, PUBLICATION, WORKERS, withPublication } from './workers.mjs';

export const LIFECYCLE = join(WORKERS, 'lifecycle');
export const SETTLED_GRACE_MS = 5000;
// A settled worker makes no one wake it again, so it closes itself a grace after its final reply; the person set five minutes.
export const AUTO_CLOSE_MS = 5 * 60_000;
export const AUTO_CLOSE_REASON = 'finished';
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

function taskFacts(worker) {
  const result = existsSync(worker.resultFile) && lstatSync(worker.resultFile);
  const resultReady = Boolean(result && result.isFile() && result.size > 0);
  return { kind: 'task', resultFile: worker.resultFile, resultReady };
}

function repositoryFacts(worker, cwd) {
  const options = { cwd };
  const phase = withPublication(worker).publication;
  return {
    uncommitted: command('git', ['status', '--porcelain'], options).split('\n').filter(Boolean).length,
    unpushed: Number(command('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], options)),
    ...(phase && { publication: phase }),
  };
}

export const completionFacts = (worker, cwd = worker.worktree) => worker.kind === 'task' ? taskFacts(worker) : repositoryFacts(worker, cwd);

export function reportFacts(worker) {
  const facts = completionFacts(worker);
  if (facts.kind === 'task') return facts;
  const options = { cwd: worker.worktree };
  return { branch: command('git', ['branch', '--show-current'], options), commit: command('git', ['rev-parse', '--short', 'HEAD'], options), ...facts };
}

// A repository worker started with its draft PR has no phase: it was published when it started.
export const isPublished = facts => facts.kind === 'task' ? facts.resultReady
  : facts.uncommitted === 0 && facts.unpushed === 0 && [undefined, PUBLICATION.published].includes(facts.publication);

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

export function canRest(state, terminal, terminals, dialogCheck = waitsForHuman) {
  const { labels = {} } = terminal;
  return [terminal.address === state.terminal, ownsTerminal(state, terminal), isLive(terminal), ['done', 'idle'].includes(terminal.status),
    !labels['agent.waiting'], !labels['agent.goal'], !labels['lifecycle.keep'], !hasUncollectedHelpers(terminal, terminals)].every(Boolean) && !dialogCheck(state, terminal);
}

export function canFinish(state, terminal, terminals, now) {
  return state?.phase === 'settled' && now >= readyAt(state) && canRest(state, terminal, terminals);
}

// A worker whose own close recorded a reason closed itself while everything was already saved: it hibernates, not crashed and not stopped.
export const isHibernated = state => state?.phase === 'closing' && Boolean(state.closeReason);
