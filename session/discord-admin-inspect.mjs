import { DISCORD_PERMISSIONS } from './discord-admin-policy.mjs';

export async function inspectDiscord(input, { api, guildId }) {
  const paths = {
    channels: `/guilds/${guildId}/channels`, roles: `/guilds/${guildId}/roles`, threads: `/guilds/${guildId}/threads/active`,
    members: `/guilds/${guildId}/members?limit=1000`, bans: `/guilds/${guildId}/bans?limit=1000`,
  };
  if (input.view === 'diagnostics') return diagnostics(api, guildId);
  if (!Object.hasOwn(paths, input.view)) throw new Error('discord-admin: inspect channels, roles, threads, members, bans or diagnostics.');
  return { view: input.view, result: await api('GET', paths[input.view]), ...(input.view === 'members' && { limit: 1000, note: 'First page only. Missing Server Members Intent produces an explicit API failure.' }) };
}

async function diagnostics(api, guildId) {
  const bot = await api('GET', '/users/@me');
  const member = await api('GET', `/guilds/${guildId}/members/${bot.id}`);
  const roles = await api('GET', `/guilds/${guildId}/roles`);
  const app = await api('GET', '/oauth2/applications/@me');
  const granted = roles.filter(role => role.id === guildId || member.roles.includes(role.id)).reduce((bits, role) => bits | BigInt(role.permissions), 0n);
  const hasAdministrator = (granted & DISCORD_PERMISSIONS.Administrator) !== 0n;
  const missingPermissions = Object.entries(DISCORD_PERMISSIONS).filter(([name, bit]) => !['Administrator', 'ManageGuild'].includes(name) && !hasAdministrator && !(granted & bit)).map(([name]) => name);
  return { view: 'diagnostics', missingPermissions, ...applicationDiagnostics(app),
    note: 'Read-only facts. Channel overrides and role hierarchy can further limit operations. No app settings were changed.' };
}

function membersIntent(app) {
  const isEnabled = (BigInt(app.flags ?? 0) & ((1n << 14n) | (1n << 15n))) !== 0n;
  return isEnabled ? 'enabled' : 'missing';
}

function applicationDiagnostics(app) {
  return { serverMembersIntent: membersIntent(app),
    publicBot: app.bot_public === false ? 'disabled' : 'enabled or unknown',
    installLink: app.custom_install_url === '' ? 'no custom link reported' : 'no definitive install-link setting returned by this endpoint' };
}
