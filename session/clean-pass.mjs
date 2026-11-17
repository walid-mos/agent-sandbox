import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { link } from './link.mjs';
import { main } from './main.mjs';
import { command } from './run.mjs';
import { liveTerminals, openTerminal, recordPass, terminalName, workers } from './workers.mjs';

const SESSION = dirname(fileURLToPath(import.meta.url));
// A pass reads its settings, skills and trusted folders here, apart from the home the router's Claude Code uses.
const CLAUDE_HOME = join(homedir(), '.config/agent-sandbox/claude');
const CLAUDE_STATE = join(CLAUDE_HOME, '.claude.json');
const UNTANGLE_SKILL = 'untangle-codebase';
const HARNESS_SKILLS = join(homedir(), '.pi/agent/skills');
const VAULT_GROUP = 'claude';
const PASSES = { untangle: `/${UNTANGLE_SKILL}`, review: '/code-review', simplify: '/simplify' };
const USAGE = `usage: clean-pass ${Object.keys(PASSES).join('|')} [area]`;

function currentWorktree() {
  try {
    return command('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error('clean-pass: run it from the worktree the pass reads.');
  }
}

// Claude Code asks a first-run question and a trust question in a terminal, and a pass has nobody to answer them.
function prepareClaude(worktree) {
  mkdirSync(join(CLAUDE_HOME, 'skills'), { recursive: true });
  link(join(SESSION, 'claude/settings.json'), join(CLAUDE_HOME, 'settings.json'));
  link(join(HARNESS_SKILLS, UNTANGLE_SKILL), join(CLAUDE_HOME, 'skills', UNTANGLE_SKILL));
  const state = existsSync(CLAUDE_STATE) ? JSON.parse(readFileSync(CLAUDE_STATE, 'utf8')) : {};
  const projects = { ...state.projects, [worktree]: { ...state.projects?.[worktree], hasTrustDialogAccepted: true } };
  writeFileSync(`${CLAUDE_STATE}.tmp`, JSON.stringify({ ...state, hasCompletedOnboarding: true, projects }), { mode: 0o600 });
  renameSync(`${CLAUDE_STATE}.tmp`, CLAUDE_STATE);
}

function open(pass, area) {
  const worktree = currentWorktree();
  const worker = workers().find(candidate => candidate.worktree === worktree);
  const owner = worker?.name ?? basename(worktree);
  // The pass leads, so a name shortened to hc's limit still says which pass it is.
  const name = terminalName(`${pass}-${owner}`);
  if (liveTerminals().some(terminal => terminal.name === name)) {
    throw new Error(`clean-pass: ${name} is still open. Read it, then close it with hc kill ${name} and hc rm ${name}.`);
  }
  prepareClaude(worktree);
  const terminal = openTerminal({
    name, cwd: worktree, tab: owner, label: `pots.pass=${pass}`,
    vaultCommand: ['--with', VAULT_GROUP, 'env', `CLAUDE_CONFIG_DIR=${CLAUDE_HOME}`, 'claude', [PASSES[pass], ...area].join(' ')],
  });
  if (worker) recordPass(worker, pass, command('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktree }));
  return { pass, name, terminal };
}

main(import.meta, () => {
  const [pass, ...area] = process.argv.slice(2);
  if (!Object.hasOwn(PASSES, pass)) throw new Error(USAGE);
  process.stdout.write(`${JSON.stringify(open(pass, area))}\n`);
});
