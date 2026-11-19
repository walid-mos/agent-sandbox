import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCORD_ADMIN } from './discord-admin-approvals.mjs';
import { linkFolder } from './link.mjs';
import { main } from './main.mjs';
import { ROUTER_MODEL } from './models.mjs';
import { ensureRouterBot } from './router-bot.mjs';
import { isMastermind, sandbox } from './sandbox.mjs';
import { isDiscordAdminEnabled } from './discord-admin-enabled.mjs';

const VERSIONED = join(dirname(fileURLToPath(import.meta.url)), 'discord-admin');

function requireBotDefinition(definition) {
  if (definition.model !== ROUTER_MODEL) throw new Error('discord-admin: bot must use the router. Review its private definition.');
  if (definition.channels?.some(channel => channel.type === 'discord')) throw new Error('discord-admin: bot must have no Discord gateway account. Review its private definition.');
}

main(import.meta, () => {
  if (!isMastermind) {
    process.stdout.write('discord-admin: this pot is not Mastermind, so it runs no Discord Admin bot.\n');
    return;
  }
  if (!isDiscordAdminEnabled(sandbox)) {
    process.stdout.write('discord-admin: disabled in private configuration, so bootstrap creates no bot.\n');
    return;
  }
  const home = ensureRouterBot(DISCORD_ADMIN, 'Administers Discord through Mastermind with protected, audited REST operations');
  const definition = JSON.parse(readFileSync(join(home, 'bot.json'), 'utf8'));
  requireBotDefinition(definition);
  linkFolder(VERSIONED, home);
  process.stdout.write(`discord-admin: ${DISCORD_ADMIN.name} follows ${VERSIONED}. Mastermind remains its entry point.\n`);
});
