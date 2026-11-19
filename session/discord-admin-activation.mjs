import { ACTIVATION_ACTION, DISCORD_ADMIN, consumedActivation, discordAdminApprovals } from './discord-admin-approvals.mjs';
import { ACTIVATION_STATE_ID } from './discord-admin-enabled.mjs';
import { DIALOG_ID, isSnowflake } from './human-contract.mjs';

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

const scopeOf = ({ guildId, applicationId }) => ({ action: ACTIVATION_ACTION, bot: DISCORD_ADMIN.id, guildId, applicationId });

function currentActivation(record) {
  return record ? { status: 'already_active', approval: record.approval } : { status: 'awaiting_activation' };
}

export function discordAdminActivation({ state, install, ...approvalStores }) {
  const status = () => currentActivation(state.get(ACTIVATION_STATE_ID));
  const connect = async () => {
    const identity = await liveIdentity(approvalStores.api);
    const approvals = discordAdminApprovals({ ...approvalStores, guildId: identity.guildId, purpose: ACTIVATION_ACTION });
    return { identity, approvals };
  };
  const prepare = async () => {
    const current = status();
    if (current.status === 'already_active') return current;
    const { identity, approvals } = await connect();
    return approvals.authorize(scopeOf(identity), identity);
  };
  const register = async input => {
    const { approvals } = await connect();
    return approvals.register(input);
  };
  const apply = approval => {
    if (!DIALOG_ID.test(approval ?? '')) throw new Error('discord-admin: apply needs the registered activation dialog ID.');
    return state.locked(async ({ get, save, lockDescriptor }) => {
      const current = get(ACTIVATION_STATE_ID);
      if (current) return currentActivation(current);
      const { identity, approvals } = await connect();
      const request = { ...scopeOf(identity), approval };
      const recovered = await consumedActivation(request, { ...approvalStores, ownerId: identity.ownerId });
      const decision = recovered ?? await approvals.authorize(request, identity);
      if (decision.status !== 'authorized') return decision;
      await install(lockDescriptor);
      save({ id: ACTIVATION_STATE_ID, approval, ...identity });
      return { status: 'activated', approval };
    }, ACTIVATION_STATE_ID);
  };
  return { prepare, register, apply, status };
}
