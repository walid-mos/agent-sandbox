import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { link, linkFolder } from './link.mjs';
import { main } from './main.mjs';
import { ROUTER_MODEL } from './models.mjs';
import { botHome, sandbox } from './sandbox.mjs';

const VERSIONED = join(dirname(fileURLToPath(import.meta.url)), 'bot');
// Pi loads the instructions of every folder above its own, so this file reaches the bot and every worker of the session.
const SESSION_RULES = join(homedir(), 'AGENTS.md');

function removeLink(target) {
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(target);
}

function create() {
  execFileSync('pots', ['init', '--yes', '--name', sandbox.bot, '--model', ROUTER_MODEL, '--judge', 'off', '--no-chat', '--no-service'], { stdio: 'inherit' });
  if (!existsSync(botHome)) throw new Error(`bot: pots init made no ${botHome}. Give the sandbox a bot name in one word.`);
}

main(import.meta, () => {
  if (!existsSync(botHome)) create();
  linkFolder(VERSIONED, botHome);
  if (sandbox.rules) link(sandbox.rules, SESSION_RULES);
  else removeLink(SESSION_RULES);
  process.stdout.write(`bot: ${sandbox.bot} follows ${VERSIONED}${sandbox.rules ? ` and ${sandbox.rules}` : ''}\n`);
});
