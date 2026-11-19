import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discordAdminActivation } from './discord-admin-activation.mjs';
import { discordAdminApi } from './discord-admin-api.mjs';
import { installDiscordAdminBot } from './discord-admin-bot.mjs';
import { activationStore, canActivateDiscordAdmin } from './discord-admin-enabled.mjs';
import { discordAccount } from './discord-admin-runtime.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { main } from './main.mjs';
import { botHome, sandbox } from './sandbox.mjs';

const USAGE = 'discord-admin-activate: use status, prepare, register < JSON, or apply DIALOG_ID.';

function activationCommand() {
  const account = discordAccount(botHome);
  return discordAdminActivation({
    api: discordAdminApi(account.secrets), channelAccount: account.id,
    clicks: humanStore(join(HUMAN_HOME, 'discord')), pending: humanStore(join(HUMAN_HOME, 'discord-admin-activation')),
    state: activationStore(), install: installDiscordAdminBot,
  });
}

function registrationInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')); }
  catch { throw new Error('discord-admin-activate: provide the registered display IDs as JSON on stdin.'); }
}

async function run([mode, id, ...extra]) {
  if (extra.length || (id !== undefined) !== (mode === 'apply')) throw new Error(USAGE);
  if (!['status', 'prepare', 'register', 'apply'].includes(mode)) throw new Error(USAGE);
  if (!canActivateDiscordAdmin(sandbox)) {
    if (mode === 'status') return { status: 'disabled' };
    throw new Error('discord-admin: disabled. Stage the Mastermind opt-in through the provider.');
  }
  const activation = activationCommand();
  const operations = { status: activation.status, prepare: activation.prepare, register: () => activation.register(registrationInput()), apply: () => activation.apply(id) };
  return operations[mode]();
}

main(import.meta, async () => process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2)))}\n`));
