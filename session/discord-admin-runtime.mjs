import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSnowflake } from './human-contract.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

export const DISCORD_ADMIN = { id: 'discord-admin', name: 'Discord Admin' };

export function discordAccount(primaryHome) {
  const definition = JSON.parse(readFileSync(join(primaryHome, 'bot.json'), 'utf8'));
  const accounts = (definition.channels ?? []).filter(channel => channel.type === 'discord');
  if (accounts.length !== 1 || typeof accounts[0].secrets !== 'string') throw new Error('discord-admin: Mastermind must own exactly one existing Discord account with a private token reference.');
  return accounts[0];
}

function owningMap(path) {
  try {
    const mapping = JSON.parse(readFileSync(path, 'utf8'));
    if (!mapping || typeof mapping !== 'object') throw new Error();
    return mapping;
  } catch {
    throw new Error('discord-admin: owning Discord route or North Star map is missing or invalid. Restore Mastermind runtime metadata.');
  }
}

function resourceIds(value) {
  if (typeof value === 'string') return snowflakeIds(value);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [...(isSnowflake(key) ? [key] : []), ...resourceIds(child)]);
}

const snowflakeIds = value => isSnowflake(value) ? [value] : [];

function requireOneGuild(guilds) {
  if (!Array.isArray(guilds) || guilds.length !== 1) throw new Error('discord-admin: the existing app must belong to exactly one guild. Refusing ambiguous administration.');
  return guilds[0].id;
}

const cachedPotId = (cache, name) => cache?.potChannels?.[name];

function potChannelId(name, channels, cache) {
  const previous = cachedPotId(cache, name);
  const matches = previous ? channels.filter(channel => channel.id === previous) : channels.filter(channel => channel.name === name && channel.type === 0);
  if (matches.length !== 1) throw new Error('discord-admin: a pot channel cannot be identified from owning configuration and Discord metadata. Restore protection metadata.');
  return matches[0].id;
}

function channelCache(path, guildId) {
  const cache = readJson(path);
  if (cache && cache.guildId !== guildId) throw new Error('discord-admin: protection cache belongs to another guild.');
  return cache;
}

export async function discoverProtection({ api, config, primaryHome, stateDirectory }) {
  const routes = owningMap(join(primaryHome, 'workspace/discord/routes.json'));
  const northStars = owningMap(join(primaryHome, 'workspace/discord/north-star-threads.json'));
  const routeIds = resourceIds(routes);
  if (!routeIds.length) throw new Error('discord-admin: route map contains no protected resource IDs.');
  const guildId = requireOneGuild(await api('GET', '/users/@me/guilds'));
  const channels = await api('GET', `/guilds/${guildId}/channels`);
  const roles = await api('GET', `/guilds/${guildId}/roles`);
  const bot = await api('GET', '/users/@me');
  const cachePath = join(stateDirectory, 'protected-channels.json');
  const cache = channelCache(cachePath, guildId);
  const names = [...new Set([config.bot.toLowerCase(), ...Object.keys(config.doors ?? {})])];
  const potChannels = Object.fromEntries(names.map(name => [name, potChannelId(name, channels, cache)]));
  const protection = { guildId, channelIds: [...new Set([...Object.values(potChannels), ...routeIds])],
    threadIds: resourceIds(northStars), botRoleIds: roles.filter(role => role.managed && role.tags?.bot_id === bot.id).map(role => role.id) };
  if (!protection.botRoleIds.length) throw new Error('discord-admin: application managed role is missing.');
  writePrivateJson(cachePath, { guildId, potChannels });
  return protection;
}
