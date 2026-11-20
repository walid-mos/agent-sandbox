import { join } from 'node:path';
import { consumedActivation, discordAdminApprovals } from './discord-admin-approvals.mjs';
import { discordAdminApi } from './discord-admin-api.mjs';
import { discordAccount } from './discord-admin-runtime.mjs';
import { isSnowflake } from './human-contract.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { BOT_ACTIVATION_ACTION } from './bot-activation-registry.mjs';

async function liveIdentity(api) {
  const [guilds, application] = await Promise.all([api('GET', '/users/@me/guilds'), api('GET', '/users/@me')]);
  if (!Array.isArray(guilds) || guilds.length !== 1 || !isSnowflake(guilds[0]?.id) || !isSnowflake(application?.id)) {
    throw new Error('discord-admin: activation needs the shared application in exactly one guild.');
  }
  const guildId = guilds[0].id;
  const guild = await api('GET', `/guilds/${guildId}`);
  if (guild?.id !== guildId || !isSnowflake(guild.owner_id)) throw new Error('discord-admin: cannot verify the current Discord guild owner.');
  return { ownerId: guild.owner_id, guildId, applicationId: application.id };
}

export function discordBotActivation(dependencies) {
  const connect = async scope => {
    const stores = dependencies();
    const authority = await liveIdentity(stores.api);
    const context = { ...stores, ...authority, purpose: BOT_ACTIVATION_ACTION };
    const approvals = discordAdminApprovals(context);
    return { authority, approvals, context, request: { ...scope, ...authority } };
  };
  return {
    prepare: async scope => {
      const { request, authority, approvals } = await connect(scope);
      return approvals.authorize(request, authority);
    },
    register: async (scope, input) => {
      const { request, approvals } = await connect(scope);
      return approvals.register(input, request);
    },
    apply: async (scope, approval) => {
      const { request, authority, approvals, context } = await connect(scope);
      const approvedRequest = { ...request, approval };
      const decision = await consumedActivation(approvedRequest, context) ?? await approvals.authorize(approvedRequest, authority);
      return { decision, authority };
    },
  };
}

export function discordActivationStores(primaryHome) {
  const account = discordAccount(primaryHome);
  return {
    api: discordAdminApi(account.secrets), channelAccount: account.id,
    clicks: humanStore(join(HUMAN_HOME, 'discord')), pending: humanStore(join(HUMAN_HOME, 'bot-activation-approvals')),
  };
}
