import { all, ANSWERED, find, RESENDABLE } from './door-requests.mjs';
import { prepareAsk, transmitAsk } from './doors.mjs';
import { deliverBotResult, syncBotDialogs } from './human-bot.mjs';
import { packet } from './human-contract.mjs';
import { acceptDoorAnswer, cancelDialog, completionNeed, questionNeed, secretNeed } from './human-dialogs.mjs';
import { DOOR_RETRY_MS, replyReceived } from './human-doors.mjs';
import { ensureSecretPage, syncSecretPage } from './human-pages.mjs';
import { reconcilePosted } from './human-posted.mjs';
import { humanStore } from './human-store.mjs';
import { main } from './main.mjs';
import { sandbox } from './sandbox.mjs';

const PASS_MS = 2000;
const POSTED_ACK = JSON.stringify(packet('human.posted-ack', {}));
const transport = { prepare: prepareAsk, transmit: transmitAsk, find, all, acknowledge: request => replyReceived(request, POSTED_ACK) };

async function noteIssue(dialog, store, error) {
  return dialog.issue === error.message ? dialog : store.patch(dialog.id, { issue: error.message });
}

// The packet itself names any served request, so the door ask carries no --for that could close before the notice leaves.
async function sendNotice(dialog, field, need, { store, doors, now }) {
  const previous = dialog[field];
  const known = previous?.id && doors.find(previous.id);
  if (known && !RESENDABLE.includes(known.state)) return;
  if (previous && now - previous.attemptedAt < DOOR_RETRY_MS) return;
  let request;
  try {
    request = known || doors.prepare({ pot: 'mastermind', need, key: `human:${dialog.id}:${field}` });
  } catch (error) {
    await store.patch(dialog.id, { [field]: { state: 'unsent', failure: error.message, attemptedAt: now } });
    return;
  }
  await store.patch(dialog.id, { [field]: { id: request.id, state: request.state, attemptedAt: now } });
  const delivered = doors.transmit(request);
  await store.patch(dialog.id, { [field]: { id: delivered.id, state: delivered.state, failure: delivered.failure, attemptedAt: now } });
}

async function reconcileSecret(initial, options) {
  let dialog = initial;
  if (!dialog.result && dialog.expiresAt <= options.now) dialog = await cancelDialog(dialog.id, 'expired', options.store);
  dialog = await options.pages.sync(dialog.id, options.store);
  if (dialog.result) return dialog;
  try {
    return await options.pages.ensure(dialog.id, options.store);
  } catch (error) {
    return noteIssue(dialog, options.store, error);
  }
}

async function reconcileQuestion(dialog, options) {
  const request = dialog.delivery?.id && options.doors.find(dialog.delivery.id);
  if (dialog.result || request?.state !== ANSWERED) return dialog;
  try {
    await acceptDoorAnswer(dialog, request, options);
    return await options.store.patch(dialog.id, { issue: undefined });
  } catch (error) {
    return noteIssue(dialog, options.store, error);
  }
}

async function reportResult(dialog, options) {
  if (dialog.source.type === 'bot') await deliverBotResult(dialog.id, options.store);
  if (dialog.delivery?.id) await sendNotice(dialog, 'completion', completionNeed(dialog), options);
}

async function reconcileDialog(initial, options) {
  const dialog = initial.kind === 'secret' ? await reconcileSecret(initial, options) : await reconcileQuestion(initial, options);
  if (dialog.result) return reportResult(dialog, options);
  if (dialog.kind === 'question' && dialog.policy === 'local') return undefined;
  if (dialog.kind === 'secret' && (dialog.writing || !dialog.pageLink || dialog.pageRevoked)) return undefined;
  return sendNotice(dialog, 'delivery', dialog.kind === 'question' ? questionNeed(dialog) : secretNeed(dialog), options);
}

export async function reconcileHuman({ store = humanStore(), doors = transport, identity = sandbox.humanDiscord, pages = { ensure: ensureSecretPage, sync: syncSecretPage }, now = Date.now(), onError = () => {} } = {}) {
  const options = { store, doors, identity, pages, now };
  await reconcilePosted({ store, doors, onError });
  for (const dialog of store.all()) {
    try { await reconcileDialog(dialog, options); } catch (error) { onError(dialog.id, error); }
  }
}

main(import.meta, () => {
  const onError = (id, error) => process.stderr.write(`human-relay: ${id}: ${error.message}\n`);
  async function pass() {
    try {
      await syncBotDialogs();
      if (sandbox.doors?.mastermind) await reconcileHuman({ onError });
    } catch (error) { onError('scan', error); }
    setTimeout(pass, PASS_MS);
  }
  return pass();
});
