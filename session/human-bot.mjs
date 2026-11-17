import { answerText, MASTERMIND_POT } from './human-contract.mjs';
import { answerQuestion, dialogId, openDialog } from './human-dialogs.mjs';
import { storeDialogSecret } from './human-secrets.mjs';
import { humanStore } from './human-store.mjs';
import { questionIn } from './pots-questions.mjs';
import { conversation, isFromBot, say } from './terminal-conversation.mjs';

const sourceOf = message => ({ type: 'bot', message });
export const botDialogId = message => dialogId(sourceOf(message));
const SECRET_STORED = 'Requested secrets were stored in this pot.';
const botResultMessageId = dialog => dialog.result.messageId ?? `m-human-${dialog.id}`;

function inputOf(record) {
  const common = { source: sourceOf(record.id), context: record.text };
  if (record.secret) return { ...common, kind: 'secret', purpose: record.text || 'Provide the requested secret.', target: { destination: 'pots', ...record.secret } };
  const asked = questionIn(record.text);
  if (!asked) return undefined;
  return { ...common, context: asked.text, kind: 'question', policy: asked.question.purpose, scope: asked.question.scope, served: asked.question.for,
    questions: [{ id: 'answer', prompt: asked.text || 'Choose an answer.', ...asked.question }] };
}

// A plain reply answers the newest bot question before it, as a send from the pane does.
function replyTo(record, following) {
  if (record.secret) return following.find(item => !isFromBot(item) && item.answers === record.id);
  const nextQuestion = following.findIndex(item => isFromBot(item) && inputOf(item)?.kind === 'question');
  const replies = nextQuestion < 0 ? following : following.slice(0, nextQuestion);
  return replies.find(item => !isFromBot(item) && !item.answers);
}

export async function syncBotDialogs(store = humanStore(), snapshot = conversation()) {
  const records = snapshot.filter(record => record.type === 'message');
  for (const [index, record] of records.entries()) {
    if (!isFromBot(record)) continue;
    const input = inputOf(record);
    if (!input) continue;
    const reply = replyTo(record, records.slice(index + 1));
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

function botAnswers(dialog, text) {
  const question = dialog.questions[0];
  const lines = text.split('\n');
  const isSelection = lines.every(line => question.options.some(option => option.label === line));
  return [{ id: question.id, labels: isSelection ? lines : [], text: isSelection ? '' : text }];
}

export async function deliverBotResult(id, store = humanStore()) {
  return store.locked(({ get, save }) => {
    const dialog = get(id);
    if (dialog.source.type !== 'bot' || !dialog.result || dialog.deliveredToBot) return;
    const messageId = botResultMessageId(dialog);
    if (!conversation().some(record => record.id === messageId || record.answers === dialog.source.message)) {
      const text = dialog.result.status === 'stored' ? SECRET_STORED
        : dialog.result.status === 'answered' ? answerText(dialog.result.answers) : `Question ${dialog.result.status}.`;
      say({ id: messageId, text, ...(dialog.kind === 'secret' && { answers: dialog.source.message }), humanDialog: id, humanStatus: dialog.result.status,
        neighbourReport: dialog.result.evidence ? { pot: MASTERMIND_POT, ...dialog.result.evidence, approval: dialog.policy === 'push', scope: dialog.scope, dialog: dialog.id, digest: dialog.result.digest } : undefined });
    }
    save({ ...dialog, deliveredToBot: true });
  }, id);
}

/** Answers the bot question a message asks with the person's text, and resolves to the ID of the reply it records. */
export async function answerBotQuestion(message, text, replyId, store = humanStore()) {
  const dialog = store.get(botDialogId(message));
  if (dialog?.kind !== 'question') throw new Error('pots: that message has no question. Refresh the conversation.');
  const answered = await answerQuestion(dialog.id, { answers: botAnswers(dialog, text) }, { store, messageId: replyId });
  await deliverBotResult(dialog.id, store);
  return botResultMessageId(answered);
}

/** Stores the secrets a bot message asks for, and resolves to the text the bot receives. */
export async function storeBotSecret(message, values, store = humanStore()) {
  await storeDialogSecret(botDialogId(message), values, { store });
  await deliverBotResult(botDialogId(message), store);
  return SECRET_STORED;
}
