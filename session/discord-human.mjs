import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptDiscordClick, closeDiscordQuestion, registerDiscordQuestion } from './discord-clicks.mjs';
import { discordInbox } from './discord-inbox.mjs';
import { all, find } from './door-requests.mjs';
import { prepareAsk, transmitAsk } from './doors.mjs';
import { packet } from './human-contract.mjs';
import { DOOR_RETRY_MS, replyReceived } from './human-doors.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { main } from './main.mjs';
import { botHome, botId, isMastermind, sandbox } from './sandbox.mjs';

const FOLDER = join(HUMAN_HOME, 'discord');
const POLL_MS = 100;
const DELIVERY_MS = 2000;
const ANSWERED_ACK = JSON.stringify(packet('human.answered-ack', {}));
const store = () => humanStore(FOLDER);

function callDiscord(channel, method, body) {
  return new Promise((resolve, reject) => {
    const child = execFile('pots', ['call', '--bot', botId, channel, method, '-'], { timeout: 10_000 }, error => error ? reject(new Error('discord-human: the message update was not confirmed.')) : resolve());
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(body));
  });
}

async function updateMessage(record, questionId, update) {
  await store().locked(async ({ get, save }) => {
    const current = get(record.id);
    if (JSON.stringify(current.updates?.[questionId]) !== JSON.stringify(update)) return;
    await callDiscord(current.registration.channelAccount, `PATCH /channels/${update.channelId}/messages/${update.messageId}`, update.body);
    const updates = { ...current.updates };
    delete updates[questionId];
    save({ ...current, updates });
  }, record.id);
}

async function posted(record) {
  const { question, request, pot, guildId, messages } = record.registration;
  const need = packet('human.posted', { dialog: record.id, request, digest: question.digest, guildId, at: new Date().toISOString(),
    messages: messages.map((message, index) => ({ question: question.questions[index].id,
      messageUrl: `https://discord.com/channels/${guildId}/${message.channelId}/${message.messageId}` })) });
  const door = prepareAsk({ pot, need: JSON.stringify(need), served: request, key: `human-posted:${record.id}` });
  const delivered = transmitAsk(door);
  await store().patch(record.id, { postedRequest: delivered.id });
  if (!['open', 'answered'].includes(delivered.state)) throw new Error('discord-human: posted context was not delivered. Keep the question disabled and retry register.');
}

async function register(registration) {
  const request = find(registration.request);
  if (request?.direction !== 'received' || request.pot !== registration.pot) throw new Error('discord-human: no matching incoming door request.');
  const block = /```question\s*\n([\s\S]*?)\n```/.exec(request.need);
  if (!block || JSON.stringify(JSON.parse(block[1])) !== JSON.stringify(registration.question)) throw new Error('discord-human: question differs from the incoming request.');
  const record = await registerDiscordQuestion(registration, store(), sandbox.humanDiscord);
  await posted(record);
  return { dialog: record.id, registered: true };
}

async function completions(onError) {
  for (const request of all().filter(item => item.direction === 'received')) {
    let completion;
    try { completion = JSON.parse(request.need); } catch { continue; }
    if (completion?.type !== 'human.answered') continue;
    if (!/^[a-f0-9]{32}$/.test(completion.dialog) || !completion.request?.startsWith(`${request.pot}.`)) continue;
    const record = store().get(completion.dialog);
    if (record?.registration && record.registration.pot !== request.pot) continue;
    try {
      await closeDiscordQuestion(completion, store(), request.pot);
      await replyReceived(request, ANSWERED_ACK);
    } catch { onError('A question completion remains pending.'); }
  }
}

async function deliverAnswer(record) {
  if (!record.outbox || record.replySent || Date.now() - (record.attemptedAt ?? 0) < DOOR_RETRY_MS) return;
  await store().patch(record.id, { attemptedAt: Date.now() });
  const request = find(record.registration.request);
  await replyReceived(request, JSON.stringify(record.outbox));
  await store().patch(record.id, { replySent: find(request.id).state === 'answered' });
}

export function startDiscordHuman({ onError = () => {} } = {}) {
  const inbox = discordInbox(join(botHome, 'bot.sqlite'));
  const cursorPath = join(FOLDER, 'cursor.json');
  store();
  let cursor = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, 'utf8')).id : 0;
  async function clicks() {
    try {
      for (const event of inbox.after(cursor)) {
        try {
          const result = await acceptDiscordClick(event.interaction, { store: store(), identity: sandbox.humanDiscord, channelAccount: event.channel, at: new Date(event.at).toISOString() });
          if (result.status === 'accepted') {
            const record = store().get(/(?:human|form:human-answer):([a-f0-9]{32})/.exec(event.interaction.data.custom_id)[1]);
            for (const [id, update] of Object.entries(record.updates ?? {})) await updateMessage(record, id, update);
          }
        } catch { onError('A click was rejected or its message update needs retry.'); }
        cursor = event.id;
        writeFileSync(`${cursorPath}.tmp`, JSON.stringify({ id: cursor }), { mode: 0o600 });
        renameSync(`${cursorPath}.tmp`, cursorPath);
      }
    } catch { onError('The Discord interaction log could not be read.'); }
    setTimeout(clicks, POLL_MS);
  }
  async function delivery() {
    try {
      await completions(onError);
      for (const record of store().all()) {
        try {
          for (const [id, update] of Object.entries(record.updates ?? {})) await updateMessage(record, id, update);
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
    process.stdout.write(`${JSON.stringify(await register(registration))}\n`);
    return;
  }
  startDiscordHuman({ onError: message => process.stderr.write(`discord-human: ${message}\n`) });
});
