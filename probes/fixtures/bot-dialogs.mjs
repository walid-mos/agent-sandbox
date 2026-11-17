import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OPERATOR = '10000000000000001';
const GUILD = '10000000000000003';
const CHANNEL = '10000000000000004';
const MESSAGE = '10000000000000005';
const MESSAGE_URL = `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`;
export const IDENTITY = { pushApprovalsEnabled: true, userId: OPERATOR };
export const PUSH_SCOPE = `Push agent-sandbox fix/proof to https://github.com/walid-mos/agent-sandbox.git at ${'a'.repeat(40)}, one push`;

function fixtureDoors() {
  const requests = new Map();
  return {
    find: id => requests.get(id),
    all: () => [...requests.values()],
    acknowledge: async () => {},
    prepare: ({ pot, need }) => {
      const request = { id: `proof.${`${requests.size + 1}`.padStart(8, '0')}`, direction: 'asked', state: 'open', pot, need };
      requests.set(request.id, request);
      return request;
    },
    transmit: request => request,
  };
}

export async function botDialogFixture(home) {
  const { humanStore } = await import('../../session/human-store.mjs');
  const { botDialogId, syncBotDialogs } = await import('../../session/human-bot.mjs');
  const { reconcileHuman } = await import('../../session/human-relay.mjs');
  const { conversation, say, TERMINAL } = await import('../../session/terminal-conversation.mjs');
  const store = humanStore(mkdtempSync(join(home, 'dialogs-')));
  const doors = fixtureDoors();
  const issues = [];
  say({ text: 'Initialize the temporary conversation' });
  writeFileSync(join(TERMINAL, 'platform.jsonl'), '');
  const pass = async () => {
    await syncBotDialogs(store);
    await reconcileHuman({ store, doors, identity: IDENTITY, pages: { sync: id => store.get(id) }, onError: (id, error) => issues.push({ id, error }) });
    if (issues.length) throw issues[0].error;
  };
  const ask = (id, options, extra = {}, at = '2026-11-17T16:12:33Z') => {
    say({ id, person: 'bot', at: Date.parse(at),
      text: `Choose an answer\n\`\`\`question\n${JSON.stringify({ purpose: 'ordinary', options, ...extra })}\n\`\`\`` });
    return botDialogId(id);
  };
  return { store, doors, pass, ask, conversation, say };
}

export async function discordAnswer(fixture, id, label) {
  const { questionDigest } = await import('../../session/human-dialogs.mjs');
  const { registerPosted } = await import('../../session/human-posted.mjs');
  const dialog = fixture.store.get(id);
  await registerPosted({ type: 'human.posted', version: 1, dialog: id, request: dialog.delivery.id, digest: questionDigest(dialog), guildId: GUILD,
    messages: [{ question: 'answer', messageUrl: MESSAGE_URL }] }, fixture.store);
  Object.assign(fixture.doors.find(dialog.delivery.id), { state: 'answered', reply: JSON.stringify({
    type: 'human.answer', version: 1, dialog: id, request: dialog.delivery.id, digest: questionDigest(dialog),
    answers: [{ id: 'answer', labels: [label], text: '' }],
    clicks: [{ question: 'answer', userId: OPERATOR, guildId: GUILD, messageUrl: MESSAGE_URL, at: '2026-11-17T16:18:25Z' }],
  }) });
  await fixture.pass();
}

export function completionNotices(fixture, id) {
  return fixture.doors.all().map(request => {
    try { return JSON.parse(request.need); } catch { return undefined; }
  }).filter(packet => packet?.type === 'human.answered' && packet.dialog === id);
}
