import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCORD_ADMIN } from './discord-admin-runtime.mjs';
import { linkFolder } from './link.mjs';
import { main } from './main.mjs';
import { ROUTER_MODEL } from './models.mjs';
import { isMastermind, potsBotHome } from './sandbox.mjs';

const VERSIONED = join(dirname(fileURLToPath(import.meta.url)), 'discord-admin');

main(import.meta, () => {
  if (!isMastermind) {
    process.stdout.write('discord-admin: this pot is not Mastermind, so it runs no Discord Admin bot.\n');
    return;
  }
  const home = potsBotHome(DISCORD_ADMIN.id);
  if (!existsSync(home)) execFileSync('pots', ['bot', 'new', DISCORD_ADMIN.name, '--id', DISCORD_ADMIN.id, '--model', ROUTER_MODEL, '--judge', 'off',
    '--about', 'Administers Discord through Mastermind with protected, audited REST operations'], { stdio: 'inherit' });
  const definition = JSON.parse(readFileSync(join(home, 'bot.json'), 'utf8'));
  if (definition.model !== ROUTER_MODEL || definition.channels?.some(channel => channel.type === 'discord')) throw new Error('discord-admin: bot must use the router and have no Discord gateway account. Review its private definition.');
  linkFolder(VERSIONED, home);
  process.stdout.write(`discord-admin: ${DISCORD_ADMIN.name} follows ${VERSIONED}. Mastermind remains its entry point.\n`);
});
