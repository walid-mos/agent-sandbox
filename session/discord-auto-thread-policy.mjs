import { isDiscordAdminEnabled } from './discord-admin-enabled.mjs';
import { snowflake } from './discord-admin-operations.mjs';

const SOURCES = ['replies', 'bots', 'webhooks', 'feeds'];
const DEFAULT_NAME = 'Discussion';
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Configure discordAutoThreads with a guildId and valid channel rules in Mastermind private configuration.');

function channelRule(channelId, rule) {
  if (!snowflake(channelId) || !isRecord(rule)) throw invalid();
  if (!Object.keys(rule).every(key => ['name', 'include'].includes(key))) throw invalid();
  const { name = DEFAULT_NAME, include = [] } = rule;
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)) throw invalid();
  if (!Array.isArray(include) || !include.every(source => SOURCES.includes(source))) throw invalid();
  return [channelId, { name, include: [...new Set(include)].sort() }];
}

export function autoThreadPolicy(config) {
  const rule = config.discordAutoThreads;
  if (!isDiscordAdminEnabled(config) || rule === undefined) return;
  if (!isRecord(rule) || !Object.keys(rule).every(key => ['guildId', 'channels'].includes(key))) throw invalid();
  if (!snowflake(rule.guildId) || !isRecord(rule.channels)) throw invalid();
  const rules = new Map(Object.entries(rule.channels).sort().map(([id, value]) => channelRule(id, value)));
  if (rules.size) return { guildId: rule.guildId, rules };
}
