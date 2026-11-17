import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROUTER_MODEL } from './models.mjs';
import { command, WITH_VAULT } from './run.mjs';

export const WORKERS = join(homedir(), '.config/agent-sandbox/workers');
export const RESUME = '--continue';
export const WORKER_PREFIX = 'pots-';
// hc accepts terminal names of at most 32 characters.
const TERMINAL_NAME_LIMIT = 32;
const DIGEST_LENGTH = 6;
// The session user can lower a priority and never raise one, so workers and passes step down and the pane's requests keep theirs.
const WORKER_NICENESS = '10';

export function terminalName(text, identity = text) {
  const readable = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (readable.length <= TERMINAL_NAME_LIMIT) return readable;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, DIGEST_LENGTH);
  return `${readable.slice(0, TERMINAL_NAME_LIMIT - DIGEST_LENGTH - 1)}-${digest}`;
}

export function workers() {
  if (!existsSync(WORKERS)) return [];
  return readdirSync(WORKERS).filter(path => path.endsWith('.json'))
    .map(path => JSON.parse(readFileSync(join(WORKERS, path), 'utf8')));
}

export function save(worker) {
  mkdirSync(WORKERS, { recursive: true });
  const path = join(WORKERS, `${worker.name}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(worker), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

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
  const path = passRecord(worker.name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

export function recordPass(worker, pass, commit) {
  writeFileSync(passRecord(worker.name), JSON.stringify({ ...passes(worker), [pass]: commit }));
}

export const isLive = terminal => terminal.state === 'live';

export function allTerminals() {
  return JSON.parse(command('hc', ['ls', '--all'])).terminals;
}

export function liveTerminals() {
  return allTerminals().filter(isLive);
}

export function terminalOf(worker, terminals) {
  return terminals.find(terminal => terminal.name === worker.name);
}

/** Writes the terminal's screen beside the worker's record, and resolves to that file. */
export function keepScreen(worker, terminal) {
  const path = join(WORKERS, `${worker.name}.screen`);
  writeFileSync(path, command('hc', ['read', terminal.address]), { mode: 0o600 });
  return path;
}

// hc keeps an ended terminal in its list until it is removed, so every end of a worker's terminal removes it.
export function closeTerminal(worker, terminal) {
  keepScreen(worker, terminal);
  if (isLive(terminal)) command('hc', ['kill', terminal.address]);
  command('hc', ['rm', terminal.address]);
}

export function endTerminal(worker, terminals) {
  const terminal = terminalOf(worker, terminals);
  if (terminal) closeTerminal(worker, terminal);
}

export function openTerminal({ name, cwd, tab, options = [], label, vaultCommand }) {
  command('hc', ['run', '--bg', ...options, '--name', name, '--cwd', cwd, '--label', label,
    '--label', 'herdr.space=sppots', '--label', `herdr.tab=tb${tab}`,
    '--', 'nice', '-n', WORKER_NICENESS, WITH_VAULT, ...vaultCommand]);
  return JSON.parse(command('hc', ['get', name])).address;
}

export function launch(worker, conversation) {
  const terminal = openTerminal({
    name: worker.name, cwd: worker.worktree, tab: worker.name, label: 'pots.worker=true',
    options: ['--no-parent', '--no-notify', '--outlive-parent'],
    vaultCommand: ['pi', '--provider', 'magpie', '--model', worker.model ?? ROUTER_MODEL, ...conversation],
  });
  const launched = { ...worker, terminal, startedAt: Date.now(), isClosed: false };
  save(launched);
  return launched;
}
