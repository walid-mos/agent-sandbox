import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptDiscordClick, closeDiscordQuestion } from './discord-clicks.mjs';
import { discordInbox } from './discord-inbox.mjs';
import { ANSWERED, RECEIVED } from './door-requests.mjs';
import { DIALOG } from './door-messages.mjs';
import { storedPacket } from './human-door-packets.mjs';
import { reconcileRegistrations, registerQuestion, REGISTRATION_EXIT } from './discord-registration.mjs';
import { dialogDoors, DOOR_RETRY_MS } from './human-doors.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { main } from './main.mjs';
import { commandWithInput } from './run.mjs';
import { botHome, botId, isMastermind, sandbox } from './sandbox.mjs';

const FOLDER = join(HUMAN_HOME, 'discord');
const POLL_MS = 100;
const DELIVERY_MS = 2000;
const store = humanStore(FOLDER);

function callDiscord(channel, method, body) {
  return commandWithInput('pots', ['call', '--bot', botId, channel, method, '-'], JSON.stringify(body), { timeout: 10_000 }).catch(() => {
    throw new Error('discord-human: the message update was not confirmed.');
  });
}

async function updateMessage(id, questionId, update) {
  await store.locked(async ({ get, save }) => {
    const current = get(id);
    if (JSON.stringify(current.updates?.[questionId]) !== JSON.stringify(update)) return;
    await callDiscord((current.registration ?? current.savedRegistration).channelAccount, `PATCH /channels/${update.channelId}/messages/${update.messageId}`, update.body);
    const updates = { ...current.updates };
    delete updates[questionId];
    save({ ...current, updates });
  }, id);
}

/** Applies the message updates a durable claim left behind, so a restart finishes the claim it read back. */
async function settle(record) {
  for (const [id, update] of Object.entries(record.updates ?? {})) await updateMessage(record.id, id, update);
}

const isCompletionOwner = (record, pot) => !record?.registration || record.registration.pot === pot;
const isCompletionAcknowledged = (request, record, completion) => request.state === ANSWERED && JSON.stringify(record?.closed) === JSON.stringify(completion);

function currentCompletion(request) {
  const completion = storedPacket(request, 'human.answered');
  if (!completion) return undefined;
  const record = store.get(completion.dialog);
  const canComplete = [isCompletionOwner(record, request.pot), !isCompletionAcknowledged(request, record, completion)].every(Boolean);
  return canComplete ? completion : undefined;
}

async function completeRequest(request, onError) {
  const completion = currentCompletion(request);
  if (!completion) return;
  try {
    await closeDiscordQuestion(completion, store, request.pot);
    await dialogDoors.acknowledge(request);
  } catch { onError('A question completion remains pending.'); }
}

async function completions(onError) {
  for (const request of dialogDoors.all().filter(item => item.kind === DIALOG && item.direction === RECEIVED)) await completeRequest(request, onError);
}

async function deliverAnswer(record) {
  const isWaiting = !record.outbox || record.replySent || Date.now() - (record.attemptedAt ?? 0) < DOOR_RETRY_MS;
  if (isWaiting) return;
  await store.patch(record.id, { attemptedAt: Date.now() });
  const { id } = record.registration;
  await dialogDoors.reply(id, JSON.stringify(record.outbox));
  await store.patch(record.id, { replySent: dialogDoors.find(id).state === ANSWERED });
}

function startDiscordHuman({ onError = () => {} } = {}) {
  const inbox = discordInbox(join(botHome, 'bot.sqlite'));
  const cursorPath = join(FOLDER, 'cursor.json');
  let cursor = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, 'utf8')).id : 0;
  async function readClick(row) {
    try {
      const result = await acceptDiscordClick(row, { store, identity: sandbox.humanDiscord, channelAccount: row.channel, at: new Date(row.at).toISOString() });
      if (['accepted', 'stale'].includes(result.status)) await settle(store.get(result.dialog));
    } catch (error) {
      if (error?.isTransient) {
        onError('The dialog store is busy, so this click is retried on the next poll.');
        return false;
      }
      onError(`A click was rejected: ${error.message}`);
    }
    return true;
  }
  async function clicks() {
    try {
      for (const row of inbox.after(cursor)) {
        if (!(await readClick(row))) break;
        cursor = row.id;
        writeFileSync(`${cursorPath}.tmp`, JSON.stringify({ id: cursor }), { mode: 0o600 });
        renameSync(`${cursorPath}.tmp`, cursorPath);
      }
    } catch { onError('The Discord interaction log could not be read.'); }
    setTimeout(clicks, POLL_MS);
  }
  async function delivery() {
    try {
      await completions(onError);
      await reconcileRegistrations(store, onError);
      for (const record of store.all()) {
        try {
          await settle(record);
          await deliverAnswer(record);
        } catch { onError('A Discord update or door delivery remains pending.'); }
      }
    } catch { onError('A Discord update or door delivery remains pending.'); }
    setTimeout(delivery, DELIVERY_MS);
  }
  clicks();
  delivery();
}

main(import.meta, async () => {
  if (!isMastermind) throw new Error('discord-human: only Mastermind runs this command.');
  if (process.argv[2] === 'register') {
    let registration;
    try { registration = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new Error('discord-human: unreadable registration.'); }
    const result = await registerQuestion(registration, { store, identity: sandbox.humanDiscord });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = REGISTRATION_EXIT[result.state];
    return;
  }
  startDiscordHuman({ onError: message => process.stderr.write(`discord-human: ${message}\n`) });
});
