import { readFileSync } from 'node:fs';
import { activationStore, botActivation, canActivateBot } from './bot-activation.mjs';
import { DISCORD_OWNER_HANDLER, registeredBot } from './bot-activation-registry.mjs';
import { discordActivationStores, discordBotActivation } from './discord-bot-activation.mjs';
import { installRegisteredBot, registeredBotArguments } from './install-registered-bot.mjs';
import { main } from './main.mjs';
import { botHome, sandbox } from './sandbox.mjs';

const USAGE = 'Usage: bot-activate.mjs BOT_ID status | prepare | register < JSON | apply DIALOG_ID';
const handlers = new Map([[DISCORD_OWNER_HANDLER, () => discordBotActivation(() => discordActivationStores(botHome))]]);

function registrationInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')); }
  catch { throw new Error('bot-activate: provide the registered display IDs as JSON on stdin.'); }
}

async function runBotActivation([botId, mode, approval, ...extra]) {
  if (botId === '--help' && mode === undefined) return USAGE;
  if (extra.length || !['status', 'prepare', 'register', 'apply'].includes(mode) || (approval !== undefined) !== (mode === 'apply')) throw new Error(USAGE);
  const bot = registeredBot(botId);
  if (!canActivateBot(sandbox, bot)) {
    if (mode === 'status') return { status: 'disabled' };
    throw new Error(`${bot.id}: disabled. Stage the registered bot opt-in through the provider.`);
  }
  const activation = botActivation(bot, {
    configuration: sandbox, approvals: handlers.get(bot.handler)(), state: activationStore(),
    install: installRegisteredBot, installArguments: registeredBotArguments,
  });
  const operations = { status: activation.status, prepare: activation.prepare, register: () => activation.register(registrationInput()), apply: () => activation.apply(approval) };
  return operations[mode]();
}

main(import.meta, async () => {
  const result = await runBotActivation(process.argv.slice(2));
  process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
});
