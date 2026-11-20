import { readFileSync } from 'node:fs';
import { snowflake } from './discord-admin-operations.mjs';
import { main } from './main.mjs';

export function taskThreadTarget(taskId, tasks) {
  if (typeof taskId !== 'string' || !taskId.trim()) return;
  const task = tasks.get(taskId);
  if (!task) return;

  const { guildId, channelId, threadId, starterMessageId } = task;
  if (![guildId, channelId].every(snowflake)) throw new Error('Task thread requires saved guild and parent channel IDs.');
  if (threadId !== undefined) {
    if (!snowflake(threadId)) throw new Error('Task thread has an invalid canonical thread ID.');
    return { action: 'reuse', guildId, channelId, threadId };
  }
  if (starterMessageId === undefined) return;
  if (!snowflake(starterMessageId)) throw new Error('Task thread has an invalid starter message ID.');
  return { action: 'ensure-from-starter', guildId, channelId, threadId: starterMessageId };
}

main(import.meta, () => {
  const [taskId] = process.argv.slice(2);
  const records = JSON.parse(readFileSync(0, 'utf8'));
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Provide task records keyed by task ID.');
  const target = taskThreadTarget(taskId, new Map(Object.entries(records)));
  process.stdout.write(`${JSON.stringify(target ?? { action: 'none' })}\n`);
});
