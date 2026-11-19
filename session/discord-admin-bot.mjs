import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCORD_ADMIN } from './discord-admin-approvals.mjs';
import { linkFolder } from './link.mjs';
import { ROUTER_MODEL } from './models.mjs';
import { ensureRouterBot } from './router-bot.mjs';
import { command } from './run.mjs';

const VERSIONED = join(dirname(fileURLToPath(import.meta.url)), 'discord-admin');

const ABOUT = 'Administers Discord through Mastermind with protected, audited REST operations';
const STATUS_TIMEOUT_MS = 10_000;

function requireBotDefinition(home) {
  const path = join(home, 'bot.json');
  if (!lstatSync(home).isDirectory() || !lstatSync(path).isFile()) throw new Error('discord-admin: expected a local bot directory and regular definition file.');
  const { name, model, channels } = JSON.parse(readFileSync(path, 'utf8'));
  if (name !== DISCORD_ADMIN.name || model !== ROUTER_MODEL || !Array.isArray(channels) || channels.some(channel => channel.type !== 'terminal')) {
    throw new Error('discord-admin: expected the Discord Admin bot with the router model and terminal-only channels. Review its private definition.');
  }
}

function gatewayStatus() {
  let output;
  try { output = command('pots', ['status'], { timeout: STATUS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('discord-admin: Pots status is unavailable. Restore the running gateway and retry the same approval.'); }
  const gateway = /^gateway: running \(process \d+\)$/m.exec(output)?.[0];
  if (!gateway) throw new Error('discord-admin: Pots gateway is not running. Verify its status before retrying the same approval.');
  return { gateway, output };
}

export function installDiscordAdminBot(lockDescriptor) {
  const before = gatewayStatus();
  const home = ensureRouterBot(DISCORD_ADMIN, ABOUT, { stdio: ['ignore', 2, 2, lockDescriptor] });
  requireBotDefinition(home);
  linkFolder(VERSIONED, home);
  const after = gatewayStatus();
  const prefix = `${DISCORD_ADMIN.id}: ${DISCORD_ADMIN.name}, ${ROUTER_MODEL}, `;
  const states = ['idle, channels terminal', 'working, channels terminal'];
  if (after.gateway !== before.gateway || !states.some(state => after.output.split('\n').includes(prefix + state))) {
    throw new Error('discord-admin: the original gateway did not confirm the running Admin bot. Check Pots status before retrying the same approval.');
  }
}
