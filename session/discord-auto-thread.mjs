import { CHANNEL, snowflake } from './discord-admin-operations.mjs';

const MESSAGE = { default: 0, reply: 19 };
const FLAG = { crosspost: 1 << 1, hasThread: 1 << 5 };

function targetOf(event, policy) {
  const message = event.message;
  if (event.inThread || message?.guild_id !== policy.guildId) return;
  if (![message.id, message.channel_id].every(snowflake)) return;
  const rule = policy.rules.get(message.channel_id);
  if (rule) return { guildId: policy.guildId, channelId: message.channel_id, messageId: message.id, rule };
}

function permitsMessage(message, rule, botId) {
  if (!snowflake(message.author?.id) || message.author.id === botId || message.interaction_metadata) return false;
  if (message.type === MESSAGE.reply && !rule.include.includes('replies')) return false;
  if (![MESSAGE.default, MESSAGE.reply].includes(message.type)) return false;
  if (message.flags & FLAG.crosspost) return rule.include.includes('feeds');
  if (message.type === MESSAGE.default && message.message_reference) return false;
  if (message.webhook_id) return rule.include.includes('webhooks');
  return message.author.bot !== true || rule.include.includes('bots');
}

function threadTypeOf(parent, { channelId, guildId, rule }, ownership) {
  if (parent?.id !== channelId || parent.guild_id !== guildId) return;
  if (ownership.channelIds.includes(channelId) || ownership.channelIds.includes(parent.parent_id)) return;
  if (parent.type === CHANNEL.text) return CHANNEL.publicThread;
  if (parent.type === CHANNEL.announcement && rule.include.includes('feeds')) return CHANNEL.announcementThread;
}

function verifyThread(thread, target) {
  const matches = [thread?.id === target.messageId, thread?.parent_id === target.channelId,
    thread?.guild_id === target.guildId, thread?.type === target.threadType];
  if (!matches.every(Boolean)) throw new Error('Discord returned a thread outside the source message scope.');
}

async function startThread(discord, target, name) {
  try {
    verifyThread(await discord.start(target, name), target);
    return 'created';
  } catch (error) {
    const thread = await discord.thread(target);
    if (!thread) throw error;
    verifyThread(thread, target);
    return 'existing';
  }
}

async function reconcileThread(discord, target, message, name, claim) {
  if (message.thread || (message.flags & FLAG.hasThread)) {
    claim(target.messageId);
    return 'existing';
  }
  const thread = await discord.thread(target);
  if (thread) {
    verifyThread(thread, target);
    claim(target.messageId);
    return 'existing';
  }
  if (!claim(target.messageId)) return 'claimed';
  return startThread(discord, target, name);
}

export async function applyAutoThread(event, { policy, discord, ownership, claim }) {
  const candidate = targetOf(event, policy);
  if (!candidate) return 'skipped';
  const { guildId, channelId, messageId, rule } = candidate;
  if (!permitsMessage(event.message, rule)) return 'skipped';
  const owned = await ownership();
  if (owned.guildId !== guildId) throw new Error('Automatic thread rules name a different Discord guild.');
  const threadType = threadTypeOf(await discord.parent(candidate), candidate, owned);
  if (!threadType) return 'skipped';
  const target = { guildId, channelId, messageId, threadType };
  const message = await discord.message(target);
  if (!message || message.id !== messageId || message.channel_id !== channelId) return 'skipped';
  if (!permitsMessage(message, rule, owned.botId)) return 'skipped';
  return reconcileThread(discord, target, message, rule.name, claim);
}
