import { isPotName, isRequestId } from './door-messages.mjs';
import { capture, discordMessage, SNOWFLAKE } from './human-contract.mjs';
import { snowflake } from './discord-admin-operations.mjs';

const THREAD_URL = new RegExp(`^https://discord\\.com/channels/${capture(SNOWFLAKE)}/${capture(SNOWFLAKE)}$`);
const invalid = () => new Error('discord-admin: invalid owning Discord metadata or guild. Restore the complete Mastermind routing and North Star contracts.');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const answeredDate = value => value === null || validDate(value);
const unique = values => new Set(values).size === values.length;

function requireFields(value, required, optional = []) {
  if (!isRecord(value)) throw invalid();
  if (!required.every(key => Object.hasOwn(value, key))) throw invalid();
  if (!Object.keys(value).every(key => [...required, ...optional].includes(key))) throw invalid();
}

function requireMap(value) {
  if (!isRecord(value)) throw invalid();
  if (!Object.keys(value).length) throw invalid();
}

function originChannels(origin) {
  if (origin === undefined) return [];
  requireFields(origin, ['channel', 'message']);
  if (![origin.channel, origin.message].every(snowflake)) throw invalid();
  return [origin.channel];
}

function routeEntry(id, entry) {
  if (!isRequestId(id)) throw invalid();
  requireFields(entry, ['pot', 'channel', 'message', 'thread', 'at', 'answered'], ['origin']);
  const checks = [isPotName(entry.pot), [entry.channel, entry.message, entry.thread].every(snowflake), validDate(entry.at), answeredDate(entry.answered)];
  if (!checks.every(Boolean)) throw invalid();
  return { channelIds: [entry.channel, ...originChannels(entry.origin)], threadIds: [entry.thread] };
}

export function routeProtection(routes) {
  requireMap(routes);
  const entries = Object.entries(routes).map(([id, entry]) => routeEntry(id, entry));
  return { channelIds: [...new Set(entries.flatMap(entry => entry.channelIds))], threadIds: [...new Set(entries.flatMap(entry => entry.threadIds))] };
}

function messageAddress(link, guildId) {
  try {
    const address = discordMessage(link);
    if (address.guildId !== guildId) throw invalid();
    return address;
  } catch { throw invalid(); }
}

function threadAddress(link, guildId) {
  const match = THREAD_URL.exec(link);
  if (!match || match[1] !== guildId) throw invalid();
  return match[2];
}

function northStarEntry(entry, guildId) {
  requireFields(entry, ['topic', 'revision', 'starter', 'thread']);
  const checks = [typeof entry.topic === 'string', Number.isSafeInteger(entry.revision), entry.revision > 0];
  if (!checks.every(Boolean)) throw invalid();
  if (!entry.topic.startsWith('north-stars/')) throw invalid();
  return { topic: entry.topic, starter: messageAddress(entry.starter, guildId), threadId: threadAddress(entry.thread, guildId) };
}

function requireThreads(threads) {
  if (!Array.isArray(threads) || !threads.length) throw invalid();
}

function requirePosts(posts, overview, entries) {
  requireFields(posts, ['overview', ...entries.map(entry => entry.topic)]);
  if (!Object.values(posts).every(snowflake)) throw invalid();
  if (posts.overview !== overview.messageId) throw invalid();
  if (!entries.every(entry => posts[entry.topic] === entry.starter.messageId)) throw invalid();
}

export function northStarProtection(registry, guildId) {
  requireFields(registry, ['type', 'version', 'overview', 'threads', 'posts']);
  if (![registry.type === 'north-star.threads', registry.version === 1].every(Boolean)) throw invalid();
  requireThreads(registry.threads);
  const overview = messageAddress(registry.overview, guildId);
  const entries = registry.threads.map(entry => northStarEntry(entry, guildId));
  if (![unique(entries.map(entry => entry.topic)), unique(entries.map(entry => entry.threadId))].every(Boolean)) throw invalid();
  requirePosts(registry.posts, overview, entries);
  return { channelIds: [...new Set([overview.channelId, ...entries.map(entry => entry.starter.channelId)])], threadIds: entries.map(entry => entry.threadId) };
}
