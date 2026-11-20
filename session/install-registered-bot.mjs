import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instructionPath } from './bot-activation.mjs';
import { link } from './link.mjs';
import { ROUTER_MODEL } from './models.mjs';
import { ensureRouterBot, routerBotArguments } from './router-bot.mjs';
import { command } from './run.mjs';

const STATUS_TIMEOUT_MS = 10_000;
const RUNNING_STATES = ['idle, channels terminal', 'working, channels terminal'];

export const registeredBotArguments = bot => routerBotArguments(bot, bot.about);

function requireBotDefinition(bot, home) {
  const path = join(home, 'bot.json');
  if (!lstatSync(home).isDirectory() || !lstatSync(path).isFile()) throw new Error(`${bot.id}: expected a local bot directory and regular definition file.`);
  const { name, model, channels } = JSON.parse(readFileSync(path, 'utf8'));
  if (name !== bot.name || model !== ROUTER_MODEL || !Array.isArray(channels) || channels.length !== 1 || channels[0]?.type !== 'terminal') {
    throw new Error(`${bot.id}: expected the registered name, router model and terminal-only channel. Review the private bot definition.`);
  }
}

function gatewayStatus() {
  let output;
  try { output = command('pots', ['status'], { timeout: STATUS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('bot-activate: Pots status is unavailable. Restore the running gateway and retry the same approval.'); }
  const gateway = /^gateway: running \(process \d+\)$/m.exec(output)?.[0];
  if (!gateway) throw new Error('bot-activate: Pots gateway is not running. Verify its status before retrying the same approval.');
  return { gateway, output };
}

export function installRegisteredBot(bot, lockDescriptor) {
  const before = gatewayStatus();
  const home = ensureRouterBot(bot, bot.about, { stdio: ['ignore', 2, 2, lockDescriptor] });
  requireBotDefinition(bot, home);
  for (const file of bot.files) link(instructionPath(bot, file), join(home, file));
  const after = gatewayStatus();
  const prefix = `${bot.id}: ${bot.name}, ${ROUTER_MODEL}, `;
  const lines = after.output.split('\n');
  if (after.gateway !== before.gateway || !RUNNING_STATES.some(state => lines.includes(prefix + state))) {
    throw new Error(`${bot.id}: the original gateway did not confirm the running bot. Check Pots status before retrying the same approval.`);
  }
}
