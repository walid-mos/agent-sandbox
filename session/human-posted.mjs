import { discordMessage, VERSION } from './human-contract.mjs';
import { questionDigest } from './human-dialogs.mjs';
import { humanStore } from './human-store.mjs';

export async function registerPosted(posted, store = humanStore()) {
  if (posted?.type !== 'human.posted' || posted.version !== VERSION) throw new Error('human: invalid posted context.');
  return store.locked(({ get, save }) => {
    const dialog = get(posted.dialog);
    if (dialog?.kind !== 'question' || posted.request !== dialog.delivery?.id || posted.digest !== questionDigest(dialog)) throw new Error('human: posted context does not match the question request and scope.');
    if (!Array.isArray(posted.messages) || posted.messages.length !== dialog.questions.length) throw new Error('human: register one message per question.');
    const messages = dialog.questions.map(question => {
      const matches = posted.messages.filter(message => message.question === question.id);
      if (matches.length !== 1 || discordMessage(matches[0].messageUrl).guildId !== posted.guildId) throw new Error('human: posted message does not match its question and guild.');
      return { question: question.id, messageUrl: matches[0].messageUrl };
    });
    if (new Set(messages.map(message => message.messageUrl)).size !== messages.length) throw new Error('human: each question needs its own Discord message.');
    const context = { request: posted.request, digest: posted.digest, guildId: posted.guildId, messages };
    if (dialog.posted && JSON.stringify(dialog.posted) !== JSON.stringify(context)) throw new Error('human: registered message context cannot change.');
    return dialog.posted ? dialog : save({ ...dialog, posted: context });
  }, posted.dialog);
}

export async function reconcilePosted({ store, doors, onError }) {
  for (const request of doors.all().filter(item => item.direction === 'received' && item.pot === 'mastermind')) {
    let posted;
    try { posted = JSON.parse(request.need); } catch { continue; }
    if (posted?.type !== 'human.posted') continue;
    try {
      await registerPosted(posted, store);
      await doors.acknowledge(request);
    } catch { onError(posted.dialog, new Error('human: posted context was rejected or its acknowledgement needs retry.')); }
  }
}
