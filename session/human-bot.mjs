import { answerText } from './human-contract.mjs';
import { answerQuestion, dialogId, openDialog } from './human-dialogs.mjs';
import { humanStore } from './human-store.mjs';
import { questionIn } from './pots-questions.mjs';
import { conversation, isFromBot, say } from './terminal-conversation.mjs';

const sourceOf = message => ({ type: 'bot', message });
export const botDialogId = message => dialogId(sourceOf(message));

function inputOf(record) {
  const common = { source: sourceOf(record.id), context: record.text };
  if (record.secret) return { ...common, kind: 'secret', purpose: record.text || 'Provide the requested secret.', target: { destination: 'pots', ...record.secret } };
  const asked = questionIn(record.text);
  if (!asked) return undefined;
  return { ...common, context: asked.text, kind: 'question', policy: asked.question.purpose, scope: asked.question.scope, served: asked.question.for,
    questions: [{ id: 'answer', prompt: asked.text || 'Choose an answer.', ...asked.question }] };
}

export async function syncBotDialogs(store = humanStore(), snapshot = conversation()) {
  const records = snapshot.filter(record => record.type === 'message');
  for (const [index, record] of records.entries()) {
    if (!isFromBot(record)) continue;
    const input = inputOf(record);
    if (!input) continue;
    const following = records.slice(index + 1);
    const reply = following.find(item => !isFromBot(item) && (record.secret ? item.answers === record.id : !item.answers));
    const existing = store.get(botDialogId(record.id));
    if (reply && !existing) continue;
    const dialog = await openDialog(input, store);
    if (!dialog.result && reply) await recordLocalReply(dialog, reply, store);
  }
}

async function recordLocalReply(dialog, reply, store) {
  if (dialog.kind === 'secret') {
    await store.locked(({ get, save }) => {
      const current = get(dialog.id);
      if (!current.result) save({ ...current, deliveredToBot: true, result: { status: 'stored', origin: 'terminal', at: reply.at } });
    }, dialog.id);
    return;
  }
  await answerQuestion(dialog.id, { answers: botAnswers(dialog, reply.text) }, { store, messageId: reply.id });
}

export function botAnswers(dialog, text) {
  const question = dialog.questions[0];
  const lines = text.split('\n');
  const isSelection = lines.every(line => question.options.some(option => option.label === line));
  return [{ id: question.id, labels: isSelection ? lines : [], text: isSelection ? '' : text }];
}

export async function deliverBotResult(id, store = humanStore()) {
  return store.locked(({ get, save }) => {
    const dialog = get(id);
    if (dialog.source.type !== 'bot' || !dialog.result || dialog.deliveredToBot) return;
    const messageId = dialog.result.messageId ?? `m-human-${id}`;
    if (!conversation().some(record => record.id === messageId || record.answers === dialog.source.message)) {
      const text = dialog.result.status === 'stored' ? 'Requested secrets were stored in this pot.'
        : dialog.result.status === 'answered' ? answerText(dialog.result.answers) : `Question ${dialog.result.status}.`;
      if (text) say({ id: messageId, text, ...(dialog.kind === 'secret' && { answers: dialog.source.message }), humanDialog: id, humanStatus: dialog.result.status,
        neighbourReport: dialog.result.evidence ? { pot: 'mastermind', ...dialog.result.evidence, approval: dialog.policy === 'push', scope: dialog.scope, dialog: dialog.id, digest: dialog.result.digest } : undefined });
    }
    save({ ...dialog, deliveredToBot: true });
  }, id);
}

