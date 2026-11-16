import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = '/etc/agent-sandbox/sandbox.json';

function load() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (error) {
    throw new Error(`sandbox: cannot read ${CONFIG}. Apply the app template, then restart the session.`, { cause: error });
  }
}

export const sandbox = load();
export const botId = sandbox.bot.toLowerCase();
export const owners = Object.keys(sandbox.owners);
export const potsBotHome = id => join(homedir(), '.pots/bots', id);
export const botHome = potsBotHome(botId);
