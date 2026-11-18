import { checkDiscordReceipt, questionDigest } from './human-dialogs.mjs';
import { humanStore } from './human-store.mjs';

async function consume(id, input, store, checkReceipt) {
  return store.locked(({ get, save }) => {
    const dialog = get(id);
    if (dialog?.kind !== 'question' || dialog.policy !== 'push') throw new Error('human: consumption requires a scoped push question.');
    const result = dialog.result;
    if (result?.status !== 'answered') throw new Error('human: the push question has not been answered.');
    if (dialog.scope !== input?.scope || result.scope !== dialog.scope || result.digest !== questionDigest(dialog)
      || result.dialog !== id || result.request !== dialog.delivery?.id) throw new Error('human: push consumption does not match its scope and receipt.');
    const [answer] = result.answers;
    if (result.answers.length !== 1 || answer.labels.length !== 1 || answer.labels[0] !== input.label || answer.text) {
      throw new Error('human: this is not the requested affirmative push answer.');
    }
    if (dialog.consumption) throw new Error('human: this push receipt was already consumed. Ask for a new approval.');
    checkReceipt?.(dialog);
    return save({ ...dialog, consumption: { scope: input.scope, label: input.label, at: Date.now() } });
  }, id);
}

export const consumePush = (id, input, store = humanStore()) => consume(id, input, store);

export async function consumeDiscordPush(id, input, store = humanStore()) {
  const { readHumanDiscord } = await import('./sandbox.mjs');
  return consume(id, input, store, dialog => checkDiscordReceipt(dialog, readHumanDiscord()));
}
