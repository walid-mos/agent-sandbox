import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

const LOCAL_TERMINAL = /^t[a-zA-Z0-9-]+$/;
const SESSION_LIMIT = 16 * 1024 * 1024;
const within = (path, root) => path.startsWith(root + sep);

export function localAddress(address) {
  if (typeof address !== 'string' || !LOCAL_TERMINAL.test(address)) throw new Error('task: use an exact local terminal address, never a machine/name route.');
  return address;
}

export function adoptionIdentity(terminal) {
  localAddress(terminal.address);
  if (!Number.isSafeInteger(terminal.created_ms) || !Array.isArray(terminal.argv)) throw new Error('task: hc must expose created_ms and argv for exact execution identity.');
  const cwd = realpathSync(terminal.cwd);
  if (!within(cwd, join(homedir(), 'Development'))) throw new Error('task: adopt only a worktree under this pot\'s Development directory.');
  const sessionFile = terminal.labels?.['pi.session'];
  const conversation = readConversation(sessionFile);
  if (terminal.state !== 'live') throw new Error('task: adoption needs a live execution. Restore or inspect the original execution first.');
  if (terminal.labels?.['pots.owner'] || terminal.labels?.['pots.launch']) throw new Error('task: this execution has managed ownership labels. Associate its registered worker instead.');
  return { terminal: terminal.address, name: terminal.name, created_ms: terminal.created_ms, argv: terminal.argv,
    cwd: terminal.cwd, worktree: cwd, parent: terminal.parent, sessionLabel: sessionFile, sessionFile: conversation.path, sessionId: conversation.id };
}

export function readConversation(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.jsonl')) throw new Error('task: terminal must publish its exact local Pi .jsonl session in pi.session.');
  const canonical = realpathSync(path);
  const roots = [join(homedir(), '.pi/agent/sessions'), join(homedir(), '.config/agent-sandbox/workers/sessions')];
  if (!roots.some(root => within(canonical, root))) throw new Error('task: session must be under this pot\'s Pi or worker session directory.');
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.size > SESSION_LIMIT) throw new Error('task: session is not a regular conversation within the inspection size limit.');
  const content = readFileSync(canonical, 'utf8');
  const header = JSON.parse(content.split('\n', 1)[0]);
  if (header.type !== 'session' || typeof header.id !== 'string' || !header.id) throw new Error('task: session has no exact Pi identity.');
  return { path: canonical, id: header.id, content };
}

function samePaths(identity, terminal) {
  try {
    return realpathSync(terminal.cwd) === identity.worktree && realpathSync(terminal.labels['pi.session']) === identity.sessionFile;
  } catch {
    return false;
  }
}

export function matchesAdoption(worker, terminal) {
  const identity = worker.adoption;
  return Boolean(identity && !terminal.labels?.['pots.owner'] && !terminal.labels?.['pots.launch'] && terminal.address === identity.terminal && terminal.created_ms === identity.created_ms &&
    terminal.cwd === identity.cwd && terminal.name === identity.name && terminal.parent === identity.parent &&
    JSON.stringify(terminal.argv) === JSON.stringify(identity.argv) && terminal.labels?.['pi.session'] === identity.sessionLabel && samePaths(identity, terminal));
}
