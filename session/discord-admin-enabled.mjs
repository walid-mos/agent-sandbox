import { MASTERMIND_POT } from './human-contract.mjs';

export const isDiscordAdminEnabled = configuration => configuration.role === MASTERMIND_POT && configuration.discordAdmin?.enabled === true;

export function requireDiscordAdminEnabled(configuration) {
  if (!isDiscordAdminEnabled(configuration)) throw new Error('discord-admin: disabled. Only the separately authorized Mastermind activation may enable discordAdmin.enabled in private sandbox configuration.');
}
