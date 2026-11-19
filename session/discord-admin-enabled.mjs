import { activationStateId, activationStore, canActivateBot } from './bot-activation.mjs';
import { DISCORD_ADMIN } from './bot-activation-registry.mjs';
import { DIALOG_ID, isSnowflake } from './human-contract.mjs';

export function requireDiscordAdminEnabled(configuration) {
  if (!canActivateBot(configuration, DISCORD_ADMIN)) throw new Error('discord-admin: disabled. Stage the Mastermind opt-in through the provider.');
  const activation = activationStore().get(activationStateId(DISCORD_ADMIN));
  const authority = activation?.authority;
  if (activation?.isInstalled !== true || activation.scope?.bot !== DISCORD_ADMIN.id || !DIALOG_ID.test(activation.approval) ||
      !isSnowflake(authority?.guildId) || !isSnowflake(authority?.applicationId)) {
    throw new Error('discord-admin: disabled. Complete the registered owner activation first.');
  }
  return authority;
}
