import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = '/etc/agent-sandbox/sandbox.json';
const MASTERMIND = 'mastermind';

function load() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (error) {
    throw new Error(`sandbox: cannot read ${CONFIG}. Apply the app template, then restart the session.`, { cause: error });
  }
}

export const sandbox = load();
if (sandbox.role !== undefined && sandbox.role !== MASTERMIND) {
  throw new Error(`sandbox: role is ${JSON.stringify(sandbox.role)} in ${CONFIG}. Leave it out for a pot that owns a domain, or set it to "${MASTERMIND}".`);
}
export const isMastermind = sandbox.role === MASTERMIND;
export const botId = sandbox.bot.toLowerCase();
export const owners = Object.keys(sandbox.owners);
export const potsHome = join(homedir(), '.pots');
export const potsBotHome = id => join(potsHome, 'bots', id);
export const botHome = potsBotHome(botId);
