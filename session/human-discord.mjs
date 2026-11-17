import { createHash } from 'node:crypto';
import { discordMessage, packet, VERSION } from './human-contract.mjs';

export function questionDigest(dialog) {
  return createHash('sha256').update(JSON.stringify({ dialog: dialog.id, questions: dialog.questions, policy: dialog.policy, scope: dialog.scope, context: dialog.context })).digest('hex');
}

export function questionPacket(dialog) {
  return packet('human.question', { dialog: dialog.id, for: dialog.served, digest: questionDigest(dialog), policy: dialog.policy,
    scope: dialog.scope, context: dialog.context, questions: dialog.questions });
}

function clickOf(question, clicks) {
  const matches = clicks.filter(click => click?.question === question.id);
  if (matches.length !== 1) throw new Error('human: answer must carry one click per question.');
  return matches[0];
}

export function checkedReply(dialog, reply) {
  if (reply?.type !== 'human.answer' || reply.version !== VERSION || reply.dialog !== dialog.id || reply.request !== dialog.delivery?.id || reply.digest !== questionDigest(dialog)) {
    throw new Error('human: answer packet does not match the dialog, its request and its scope.');
  }
  if (!Array.isArray(reply.clicks) || reply.clicks.length !== dialog.questions.length) throw new Error('human: answer must carry one click per question.');
  if (!dialog.posted) throw new Error('human: no registered Discord message context.');
  for (const question of dialog.questions) {
    const click = clickOf(question, reply.clicks);
    const message = dialog.posted.messages.find(item => item.question === question.id);
    if (click.messageUrl !== message?.messageUrl || click.guildId !== dialog.posted.guildId) throw new Error('human: click does not match its registered message.');
  }
  const messages = dialog.questions.map(question => discordMessage(clickOf(question, reply.clicks).messageUrl).messageId);
  if (new Set(messages).size !== messages.length) throw new Error('human: each question needs its own Discord message.');
}
