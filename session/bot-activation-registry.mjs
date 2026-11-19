export const BOT_ACTIVATION_ACTION = 'bot.activate';
export const DISCORD_OWNER_HANDLER = 'discord-owner-display-v1';

function definition(id, name, about, files) {
  return Object.freeze({ id, name, about, files: Object.freeze(files), handler: DISCORD_OWNER_HANDLER });
}

export const DISCORD_ADMIN = definition('discord-admin', 'Discord Admin',
  'Administers Discord through Mastermind with protected, audited REST operations', ['AGENTS.md', 'responsibilities.md']);

const SESSION_STATUS = definition('session-status', 'Session Status',
  'Reports the current Pots session status to Mastermind', ['AGENTS.md']);

const bots = new Map([DISCORD_ADMIN, SESSION_STATUS].map(bot => [bot.id, bot]));

export function registeredBot(id) {
  const bot = bots.get(id);
  if (!bot) throw new Error('bot-activate: choose a registered bot: ' + [...bots.keys()].join(', ') + '.');
  return bot;
}
