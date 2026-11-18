import { createHash } from 'node:crypto';
import { answersOf, dialogSource, discordEvidence, discordMessage, LOCAL_POLICY, MASTERMIND_POT, onlyFor, packet, policyOf, questionsOf, SECRET_TTL_MS, targetOf, VERSION } from './human-contract.mjs';
import { isRequestId } from './door-messages.mjs';
import { ANSWERED, ASKED } from './door-requests.mjs';
import { humanStore } from './human-store.mjs';
import { humanNeed } from './human-door-packets.mjs';

export const dialogId = source => createHash('sha256').update(JSON.stringify(dialogSource(source))).digest('hex').slice(0, 32);

export function questionDigest(dialog) {
  return createHash('sha256').update(JSON.stringify({ dialog: dialog.id, questions: dialog.questions, policy: dialog.policy, scope: dialog.scope, context: dialog.context })).digest('hex');
}

export function questionPacket(dialog) {
  return packet('human.question', { dialog: dialog.id, for: dialog.served, digest: questionDigest(dialog), policy: dialog.policy,
    scope: dialog.scope, context: dialog.context, questions: dialog.questions });
}

function clickOf(question, clicks) {
  const click = onlyFor(question, clicks, 'question');
  if (!click) throw new Error('human: answer must carry one click per question.');
  return click;
}

function checkedReply(dialog, reply) {
  if (reply?.type !== 'human.answer' || reply.version !== VERSION || reply.dialog !== dialog.id || reply.request !== dialog.delivery?.id || reply.digest !== questionDigest(dialog)) {
    throw new Error('human: answer packet does not match the dialog, its request and its scope.');
  }
}

function checkedClicks(dialog, clicks, identity) {
  if (!Array.isArray(clicks) || clicks.length !== dialog.questions.length) throw new Error('human: answer must carry one click per question.');
  if (!dialog.posted) throw new Error('human: no registered Discord message context.');
  const evidence = dialog.questions.map(question => {
    const click = clickOf(question, clicks);
    const message = dialog.posted.messages.find(item => item.question === question.id);
    if (click.messageUrl !== message?.messageUrl || click.guildId !== dialog.posted.guildId) throw new Error('human: click does not match its registered message.');
    return { question: question.id, ...discordEvidence(click, identity, dialog.policy) };
  });
  const messages = evidence.map(click => discordMessage(click.messageUrl).messageId);
  if (new Set(messages).size !== messages.length) throw new Error('human: each question needs its own Discord message.');
  return evidence;
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
    served: input.served, createdAt: Date.now(), policy: policyOf(input.policy), scope: input.scope };
  if (common.policy === 'push' && (typeof input.scope !== 'string' || !input.scope.trim())) throw new Error('human: an approval needs its exact scope.');
  if (input.kind === 'question') return { ...common, questions: questionsOf(input.questions) };
  if (typeof input.purpose !== 'string' || !input.purpose.trim()) throw new Error('human: a secret needs a purpose.');
  const target = targetOf(input.target);
  if (target.destination === 'browser' && common.source.type !== 'worker') throw new Error('human: only a waiting worker tool takes a browser secret.');
  return { ...common, purpose: input.purpose, target, expiresAt: Date.now() + SECRET_TTL_MS };
}

function checkedDiscordAnswer(dialog, reply, identity) {
  if (dialog.policy === LOCAL_POLICY) throw new Error('human: this question requires the pot terminal.');
  checkedReply(dialog, reply);
  return { clicks: checkedClicks(dialog, reply.clicks, identity) };
}

export function checkDiscordReceipt(dialog, identity) {
  const { result, posted } = dialog;
  if (result.origin !== 'discord' || !isRequestId(result.request) || posted?.request !== result.request || posted.digest !== result.digest) {
    throw new Error('human: first publication requires a checked receipt for its registered Discord request.');
  }
  checkAnswerDoor(dialog, result.evidence?.door);
  checkedClicks(dialog, result.evidence?.clicks, identity);
  answersOf(dialog.questions, result.answers);
}

export async function answerQuestion(id, answer, { store = humanStore(), identity, origin = 'terminal', messageId, replyDoor } = {}) {
  return store.locked(({ get, save }) => {
    const dialog = get(id);
    if (dialog?.kind !== 'question') throw new Error('human: no such question.');
    if (dialog.result) return dialog;
    let evidence;
    if (origin === 'discord') {
      if (replyDoor) checkAnswerDoor(dialog, replyDoor);
      evidence = { ...checkedDiscordAnswer(dialog, answer, identity), ...(replyDoor && { door: replyDoor }) };
    }
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

function checkAnswerDoor(dialog, request) {
  if (request?.pot !== MASTERMIND_POT || request.direction !== ASKED || request.id !== dialog.delivery?.id || request.state !== ANSWERED) throw new Error('human: answer is not a reply to this dialog from Mastermind.');
}

export async function acceptDoorAnswer(dialog, request, options) {
  checkAnswerDoor(dialog, request);
  let reply;
  try { reply = JSON.parse(request.reply); } catch { throw new Error('human: Mastermind reply is not an answer packet.'); }
  const { pot, direction, id, state } = request;
  return answerQuestion(dialog.id, reply, { ...options, origin: 'discord', replyDoor: { pot, direction, id, state } });
}

export function questionNeed(dialog) {
  return humanNeed(questionPacket(dialog));
}

export function completionNeed(dialog) {
  return JSON.stringify(packet('human.answered', { dialog: dialog.id, request: dialog.delivery.id, digest: dialog.kind === 'question' ? questionDigest(dialog) : undefined, status: dialog.result.status,
    origin: dialog.result.origin, answers: dialog.kind === 'question' ? dialog.result.answers : undefined }));
}

export function secretNeed(dialog) {
  return JSON.stringify(packet('human.secret-link', { dialog: dialog.id, for: dialog.served, purpose: dialog.purpose, url: dialog.pageLink.url, expiresAt: dialog.expiresAt }));
}
