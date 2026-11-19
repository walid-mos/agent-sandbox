import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ACTIVATION_ACTION } from './discord-admin-approvals.mjs';
import { DIALOG_ID, MASTERMIND_POT, isSnowflake } from './human-contract.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';

export const ACTIVATION_STATE_ID = createHash('sha256').update(ACTIVATION_ACTION).digest('hex').slice(0, 32);
export const activationStore = () => humanStore(join(HUMAN_HOME, 'discord-admin-activation-state'));
export const canActivateDiscordAdmin = configuration => configuration.role === MASTERMIND_POT && configuration.discordAdmin?.enabled === true;

export function isDiscordAdminEnabled(configuration, activation) {
  return canActivateDiscordAdmin(configuration) && activation?.id === ACTIVATION_STATE_ID &&
    DIALOG_ID.test(activation.approval) && isSnowflake(activation.guildId) && isSnowflake(activation.applicationId);
}

export function requireDiscordAdminEnabled(configuration) {
  if (!canActivateDiscordAdmin(configuration)) throw new Error('discord-admin: disabled. Stage the Mastermind opt-in through the provider.');
  const activation = activationStore().get(ACTIVATION_STATE_ID);
  if (!isDiscordAdminEnabled(configuration, activation)) throw new Error('discord-admin: disabled. Complete the registered owner activation first.');
  return activation;
}
