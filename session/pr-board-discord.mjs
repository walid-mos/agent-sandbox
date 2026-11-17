import { execFile } from 'node:child_process';
import { SNOWFLAKE } from './human-contract.mjs';
import { DISCORD_LIMIT } from './pr-board-contract.mjs';

export function discordConfiguration(configuration) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(configuration.channelAccount ?? '') || ![configuration.channelId, configuration.guildId].every(value => typeof value === 'string' && SNOWFLAKE.test(value))) {
    throw new Error('pr-board: configure a private Discord account, guild ID and channel ID.');
  }
  return configuration;
}

export function discordClient(configuration, botId) {
  discordConfiguration(configuration);
  const call = (method, body) => new Promise((resolve, reject) => {
    const child = execFile('pots', ['call', '--bot', botId, configuration.channelAccount, method, '-'], { timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, output) => {
      if (error) return reject(new Error('pr-board: Discord call was not confirmed.'));
      try { resolve(output.trim() ? JSON.parse(output) : {}); } catch { reject(new Error('pr-board: Discord response was not readable JSON.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(body));
  });
  const bodyOf = content => {
    if (typeof content !== 'string' || content.length > DISCORD_LIMIT) throw new Error('pr-board: Discord content exceeds its limit.');
    return { content, flags: 4, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } };
  };
  const messageId = id => {
    if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error('pr-board: Discord returned an invalid message ID.');
    return id;
  };
  const channel = `/channels/${configuration.channelId}`;
  return {
    create: async (content, nonce) => messageId((await call(`POST ${channel}/messages`, { ...bodyOf(content), nonce, enforce_nonce: true })).id),
    edit: (id, content) => call(`PATCH ${channel}/messages/${messageId(id)}`, bodyOf(content)),
    pin: id => call(`PUT ${channel}/pins/${messageId(id)}`, {}),
    link: id => `https://discord.com/channels/${configuration.guildId}/${configuration.channelId}/${messageId(id)}`,
  };
}
