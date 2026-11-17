import { createHash } from 'node:crypto';
import { answersOf, dialogSource, discordEvidence, discordMessage, packet, questionsOf, RELAYED_POLICIES, SECRET_TTL_MS, targetOf, VERSION } from './human-contract.mjs';
import { humanStore } from './human-store.mjs';

export const dialogId = source => createHash('sha256').update(JSON.stringify(dialogSource(source))).digest('hex').slice(0, 32);

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

function checkedReply(dialog, reply) {
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

export async function openDialog(input, store = humanStore()) {
  if (!['question', 'secret'].includes(input?.kind)) throw new Error('human: a dialog needs a question or secret kind.');
  const id = dialogId(input.source);
  const candidate = newDialog(input, id);
  return store.locked(({ get, save }) => {
    const existing = get(id);
    if (!existing) return save(candidate);
    const immutable = dialog => JSON.stringify([dialog.kind, dialog.questions, dialog.target, dialog.policy, dialog.scope, dialog.served, dialog.context, dialog.purpose]);
    if (immutable(existing) !== immutable(candidate)) throw new Error('human: a dialog source cannot change its question, scope or destination. Open a new call.');
    return existing;
  }, id);
}

function newDialog(input, id) {
  const common = { id, version: VERSION, kind: input.kind, source: dialogSource(input.source), context: `${input.context ?? ''}`,
    served: input.served, createdAt: Date.now(), policy: RELAYED_POLICIES.includes(input.policy) ? input.policy : 'local', scope: input.scope };
  if (common.policy === 'push' && (typeof input.scope !== 'string' || !input.scope.trim())) throw new Error('human: an approval needs its exact scope.');
  if (input.kind === 'question') return { ...common, questions: questionsOf(input.questions) };
  if (typeof input.purpose !== 'string' || !input.purpose.trim()) throw new Error('human: a secret needs a purpose.');
  const target = targetOf(input.target);
  if (target.destination === 'browser' && common.source.type !== 'worker') throw new Error('human: only a waiting worker tool takes a browser secret.');
  return { ...common, purpose: input.purpose, target, expiresAt: Date.now() + SECRET_TTL_MS };
}

export async function answerQuestion(id, answer, { store = humanStore(), identity, origin = 'terminal', messageId } = {}) {
  return store.locked(({ get, save }) => {
    const dialog = get(id);
    if (dialog?.kind !== 'question') throw new Error('human: no such question.');
    if (dialog.result) return dialog;
    if (origin === 'discord' && dialog.policy === 'local') throw new Error('human: this question requires the pot terminal.');
    if (origin === 'discord') checkedReply(dialog, answer);
    const evidence = origin === 'discord' ? { clicks: answer.clicks.map(click => ({ question: click.question, ...discordEvidence(click, identity, dialog.policy) })) } : undefined;
    const answers = answersOf(dialog.questions, answer.answers);
    return save({ ...dialog, result: { status: 'answered', origin, answers, evidence, messageId, dialog: id, request: dialog.delivery?.id, digest: questionDigest(dialog), scope: dialog.scope, at: Date.now() } });
  }, id);
}

export async function cancelDialog(id, status = 'cancelled', store = humanStore()) {
  if (!['cancelled', 'paused', 'expired'].includes(status)) throw new Error('human: invalid close status.');
  return store.locked(({ get, save }) => {
    const dialog = get(id);
    if (!dialog) throw new Error('human: no such dialog.');
    return dialog.result ? dialog : save({ ...dialog, result: { status, origin: 'terminal', at: Date.now() } });
  }, id);
}

export async function acceptDoorAnswer(dialog, request, options) {
  if (request.pot !== 'mastermind' || request.direction !== 'asked' || request.id !== dialog.delivery?.id || request.state !== 'answered') throw new Error('human: answer is not a reply to this dialog from Mastermind.');
  let reply;
  try { reply = JSON.parse(request.reply); } catch { throw new Error('human: Mastermind reply is not an answer packet.'); }
  checkedReply(dialog, reply);
  return answerQuestion(dialog.id, reply, { ...options, origin: 'discord' });
}

export function questionNeed(dialog) {
  const question = questionPacket(dialog);
  return `${dialog.context || 'A worker waits for your answer.'}\n\n\`\`\`question\n${JSON.stringify(question)}\n\`\`\``;
}

export function completionNeed(dialog) {
  return JSON.stringify(packet('human.answered', { dialog: dialog.id, request: dialog.delivery.id, digest: dialog.kind === 'question' ? questionDigest(dialog) : undefined, status: dialog.result.status,
    origin: dialog.result.origin, answers: dialog.kind === 'question' ? dialog.result.answers : undefined }));
}

export function secretNeed(dialog) {
  return JSON.stringify(packet('human.secret-link', { dialog: dialog.id, for: dialog.served, purpose: dialog.purpose, url: dialog.pageLink.url, expiresAt: dialog.expiresAt }));
}
