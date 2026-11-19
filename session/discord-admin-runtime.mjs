import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL } from './discord-admin-operations.mjs';
import { protectedChannels, protectionOf } from './discord-admin-protection.mjs';
import { northStarProtection, routeProtection } from './discord-admin-metadata.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

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

function requireOneGuild(guilds) {
  if (!Array.isArray(guilds) || guilds.length !== 1) throw new Error('discord-admin: the existing app must belong to exactly one guild. Refusing ambiguous administration.');
  return guilds[0].id;
}

function potChannelId(name, channels, cache) {
  const previous = channels.some(channel => channel.id === cache?.potChannels?.[name]) ? cache.potChannels[name] : undefined;
  const matches = previous ? channels.filter(channel => channel.id === previous) : channels.filter(channel => channel.name === name && channel.type === CHANNEL.text);
  if (matches.length !== 1) throw new Error('discord-admin: a pot channel cannot be identified from owning configuration and Discord metadata. Restore protection metadata.');
  return matches[0].id;
}

function channelCache(path, guildId) {
  const cache = readJson(path);
  if (cache && cache.guildId !== guildId) throw new Error('discord-admin: protection cache belongs to another guild.');
  return cache;
}

async function discoverOwnership({ api, config, primaryHome, stateDirectory }) {
  const routes = owningMap(join(primaryHome, 'workspace/discord/routes.json'));
  const northStars = owningMap(join(primaryHome, 'workspace/discord/north-star-threads.json'));
  const routing = routeProtection(routes);
  const [guilds, bot] = await Promise.all([api('GET', '/users/@me/guilds'), api('GET', '/users/@me')]);
  const guildId = requireOneGuild(guilds);
  const northStar = northStarProtection(northStars, guildId);
  const [channels, roles] = await Promise.all([api('GET', `/guilds/${guildId}/channels`), api('GET', `/guilds/${guildId}/roles`)]);
  const cachePath = join(stateDirectory, 'protected-channels.json');
  const cache = channelCache(cachePath, guildId);
  const names = [...new Set([config.bot.toLowerCase(), ...Object.keys(config.doors ?? {})])];
  const potChannels = Object.fromEntries(names.map(name => [name, potChannelId(name, channels, cache)]));
  const protection = protectionOf({ guildId, roles, botId: bot.id,
    channelIds: [...Object.values(potChannels), ...routing.channelIds, ...northStar.channelIds], threadIds: [...routing.threadIds, ...northStar.threadIds] });
  writePrivateJson(cachePath, { guildId, potChannels });
  return { channels, protection, botId: bot.id };
}

export async function discoverProtection(options) {
  return (await discoverOwnership(options)).protection;
}

export async function discoverThreadOwnership(options) {
  const { channels, protection, botId } = await discoverOwnership(options);
  const tracked = await protectedChannels(channels, protection, options.api);
  return { ...tracked.protection, botId };
}
