import { discordMessage, MASTERMIND_POT, onlyFor, VERSION } from './human-contract.mjs';
import { questionDigest } from './human-dialogs.mjs';
import { DIALOG } from './door-messages.mjs';
import { ANSWERED, RECEIVED, REFUSED } from './door-requests.mjs';
import { storedPacket } from './human-door-packets.mjs';
import { humanStore } from './human-store.mjs';

export async function registerPosted(posted, store = humanStore()) {
  if (posted?.type !== 'human.posted' || posted.version !== VERSION) throw new Error('human: invalid posted context.');
  return store.locked(({ get, save }) => {
    const dialog = get(posted.dialog);
    if (dialog?.kind !== 'question' || posted.request !== dialog.delivery?.id || posted.digest !== questionDigest(dialog)) throw new Error('human: posted context does not match the question request and scope.');
    if (!Array.isArray(posted.messages) || posted.messages.length !== dialog.questions.length) throw new Error('human: register one message per question.');
    const messages = dialog.questions.map(question => {
      const match = onlyFor(question, posted.messages, 'question');
      if (!match || discordMessage(match.messageUrl).guildId !== posted.guildId) throw new Error('human: posted message does not match its question and guild.');
      return { question: question.id, messageUrl: match.messageUrl };
    });
    if (new Set(messages.map(message => message.messageUrl)).size !== messages.length) throw new Error('human: each question needs its own Discord message.');
    const context = { request: posted.request, digest: posted.digest, guildId: posted.guildId, messages };
    if (dialog.posted && JSON.stringify(dialog.posted) !== JSON.stringify(context)) throw new Error('human: registered message context cannot change.');
    return dialog.posted ? dialog : save({ ...dialog, posted: context });
  }, posted.dialog);
}

async function acknowledgePosted(request, { store, doors, onError }) {
  const posted = storedPacket(request, 'human.posted');
  if (!posted) return;
  try {
    await registerPosted(posted, store);
    await doors.acknowledge(request);
  } catch { onError(posted.dialog, new Error('human: posted context was rejected or its acknowledgement needs retry.')); }
}

export async function reconcilePosted(options) {
  const received = options.doors.all().filter(item => item.kind === DIALOG && item.direction === RECEIVED && item.pot === MASTERMIND_POT && ![ANSWERED, REFUSED].includes(item.state));
  for (const request of received) await acknowledgePosted(request, options);
}
