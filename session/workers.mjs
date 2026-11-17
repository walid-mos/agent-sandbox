import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROUTER_MODEL } from './models.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';
import { command, WITH_VAULT } from './run.mjs';

export const WORKERS = join(homedir(), '.config/agent-sandbox/workers');
export const WORKER_PREFIX = 'pots-';
// hc accepts terminal names of at most 32 characters.
const TERMINAL_NAME_LIMIT = 32;
const DIGEST_LENGTH = 6;
// The session user can lower a priority and never raise one, so workers and passes step down and the pane's requests keep theirs.
const WORKER_NICENESS = '10';
const HUMAN_BROKER = join(import.meta.dirname, 'human.mjs');

export function terminalName(text, identity = text) {
  const readable = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (readable.length <= TERMINAL_NAME_LIMIT) return readable;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, DIGEST_LENGTH);
  return `${readable.slice(0, TERMINAL_NAME_LIMIT - DIGEST_LENGTH - 1)}-${digest}`;
}

export const workerTitle = (worker, terminal) => terminal?.labels?.['agent.title'] ?? worker.title ?? worker.name.slice(WORKER_PREFIX.length);

export function workers() {
  if (!existsSync(WORKERS)) return [];
  return readdirSync(WORKERS).filter(path => path.endsWith('.json'))
    .map(path => JSON.parse(readFileSync(join(WORKERS, path), 'utf8')))
    .map(worker => ({ ...worker, ...publishedState(worker) }));
}

export function save(worker) {
  writePrivateJson(join(WORKERS, `${worker.name}.json`), worker);
}

const publicationRecord = worker => join(WORKERS, `${worker.name}.publication`);
export const publishedState = worker => readJson(publicationRecord(worker)) ?? {};
export const recordPublication = (worker, state) => writePrivateJson(publicationRecord(worker), state);

export function writeBrief(name, text) {
  mkdirSync(WORKERS, { recursive: true });
  const path = join(WORKERS, `${name}.md`);
  writeFileSync(path, text);
  return path;
}

// A stop is its own file: the watcher rewrites a record from the copy it read, and would erase a stop stored in it.
const stopMarker = name => join(WORKERS, `${name}.stopped`);

export function markStopped(worker) {
  writeFileSync(stopMarker(worker.name), '');
}

export function isStopped(worker) {
  return existsSync(stopMarker(worker.name));
}

export function clearStop(worker) {
  rmSync(stopMarker(worker.name), { force: true });
}

// The passes of a clean pass are their own file for the same reason: each maps to the commit it started on.
const passRecord = name => join(WORKERS, `${name}.passes`);

export function passes(worker) {
  return readJson(passRecord(worker.name)) ?? {};
}

export function recordPass(worker, pass, commit) {
  writeFileSync(passRecord(worker.name), JSON.stringify({ ...passes(worker), [pass]: commit }));
}

export const isLive = terminal => terminal.state === 'live';

const listedTerminals = () => JSON.parse(command('hc', ['ls', '--all', '--json'])).terminals;

// A terminal removed between the list and its details is gone, and one still listed whose details fail stops the caller, which never decides on a partial list.
function details(terminal, isStillListed) {
  try {
    return { ...JSON.parse(command('hc', ['get', '--json', terminal.address])), agent: terminal.agent };
  } catch (error) {
    if (isStillListed(terminal)) throw error;
    return undefined;
  }
}

export function allTerminals() {
  let relisted;
  const isStillListed = terminal => (relisted ??= listedTerminals()).some(listed => listed.address === terminal.address);
  return listedTerminals().map(terminal => details(terminal, isStillListed)).filter(Boolean)
    .map(terminal => ({ ...terminal, status: terminal.status?.state ?? terminal.status }));
}

export function liveTerminals() {
  return allTerminals().filter(isLive);
}

export function ownsTerminal(worker, terminal) {
  const { labels = {} } = terminal;
  return [Boolean(worker.owner), Boolean(worker.launchId), labels['pots.launch'] === worker.launchId, labels['pots.owner'] === worker.owner].every(Boolean);
}

export function terminalOf(worker, terminals) {
  return terminals.filter(terminal => terminal.name === worker.name)
    .filter(terminal => !worker.terminal || terminal.address === worker.terminal)
    .find(terminal => ownsTerminal(worker, terminal));
}

// hc keeps an ended terminal in its list until it is removed, so every end of a worker's terminal removes it.
export function closeTerminal(worker, terminal) {
  writeFileSync(join(WORKERS, `${worker.name}.screen`), command('hc', ['read', terminal.address]), { mode: 0o600 });
  if (isLive(terminal)) command('hc', ['kill', terminal.address]);
  command('hc', ['rm', terminal.address]);
}

export function endTerminal(worker, terminals) {
  const terminal = terminalOf(worker, terminals);
  if (terminal) closeTerminal(worker, terminal);
}

export function openTerminal({ name, cwd, tab, options = [], labels = [], label, vaultCommand }) {
  command('hc', ['run', '--bg', ...options, '--name', name, '--cwd', cwd, '--label', label, ...labels.flatMap(value => ['--label', value]),
    '--label', 'herdr.space=sppots', '--label', `herdr.tab=tb${tab}`,
    '--', 'nice', '-n', WORKER_NICENESS, WITH_VAULT, ...vaultCommand]);
  return JSON.parse(command('hc', ['get', name])).address;
}

// The session can install another Pi while this launcher lives, so every launch asks the installed one.
function humanDialogFlags(worker) {
  const help = command('pi', ['--help'], { timeout: 15_000 });
  if (!(help.includes('--human-dialog-worker') && help.includes('--human-dialog-broker'))) return [];
  return ['--human-dialog-worker', worker.name, '--human-dialog-broker', HUMAN_BROKER];
}

function sessionArguments(worker, sessionDir, sessionId) {
  if (!worker.sessionFile) return ['--session-dir', sessionDir, '--session-id', sessionId];
  if (!existsSync(worker.sessionFile)) throw new Error('dispatch: the recorded session file is missing. Restore it before resuming.');
  return ['--session', worker.sessionFile];
}

export function launch(worker, conversation) {
  const launchId = randomUUID();
  if (!worker.owner) throw new Error('dispatch: worker has no recorded Pots owner. Inspect it before relaunching.');
  const { sessionId = randomUUID(), sessionDir = join(WORKERS, 'sessions', worker.name), model = ROUTER_MODEL } = worker;
  mkdirSync(sessionDir, { recursive: true });
  const session = sessionArguments(worker, sessionDir, sessionId);
  const launched = { ...worker, launchId, sessionId, sessionDir, terminal: undefined, startedAt: Date.now(), isClosed: false, lastReport: undefined, result: undefined };
  save(launched);
  const terminal = openTerminal({
    name: worker.name, cwd: worker.worktree, tab: worker.name, label: 'pots.worker=true',
    labels: [`pots.owner=${worker.owner}`, `pots.launch=${launchId}`, ...(worker.title ? [`agent.title=${worker.title}`] : [])],
    options: ['--no-parent', '--no-notify', '--outlive-parent'],
    vaultCommand: ['env', `POTS_WORKER=${worker.name}`, `POTS_OWNER=${worker.owner}`, `POTS_LAUNCH=${launchId}`,
      'pi', '--extension', join(import.meta.dirname, 'worker-agent.mjs'), ...session,
      '--provider', 'magpie', '--model', model, ...humanDialogFlags(worker), ...conversation],
  });
  save({ ...launched, terminal });
  return { ...launched, terminal };
}
