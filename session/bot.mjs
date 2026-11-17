import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { link, linkFolder } from './link.mjs';
import { main } from './main.mjs';
import { ROUTER_MODEL } from './models.mjs';
import { botHome, isMastermind, potsHome, sandbox } from './sandbox.mjs';

const SESSION = dirname(fileURLToPath(import.meta.url));
const VERSIONED = join(SESSION, isMastermind ? 'mastermind' : 'bot');
// Pi loads the instructions of every folder above its own: the pot's rules reach every bot and no worker, the sandbox's rules the bot and every worker.
const POT_RULES = { source: join(SESSION, 'pot/AGENTS.md'), target: join(potsHome, 'AGENTS.md') };
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
  link(POT_RULES.source, POT_RULES.target);
  if (sandbox.rules) link(sandbox.rules, SESSION_RULES);
  else removeLink(SESSION_RULES);
  process.stdout.write(`bot: ${sandbox.bot} follows ${VERSIONED} and ${POT_RULES.source}${sandbox.rules ? ` and ${sandbox.rules}` : ''}\n`);
});
