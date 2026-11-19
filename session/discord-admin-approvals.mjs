import { randomBytes } from 'node:crypto';
import { closeDiscordQuestion, registerOwnerQuestion } from './discord-clicks.mjs';
import { DIALOG_ID, DISCORD_MESSAGE_LIMIT, MASTERMIND_POT, packet } from './human-contract.mjs';
import { questionDigest, questionPacket } from './human-dialogs.mjs';
import { approvalControls, approvalMessage, canonicalJson, requireApprovalDisplay } from './discord-admin-message.mjs';
import { snowflake } from './discord-admin-operations.mjs';

export const DISCORD_ADMIN = { id: 'discord-admin', name: 'Discord Admin' };
export const ACTIVATION_ACTION = 'discord-admin.activate';
export const APPROVE = 'Approve this operation';
export const DECLINE = 'Cancel';
const QUESTION = 'operation';
const DIALOG_BYTES = 16;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const TOO_LONG = 'discord-admin: approval scope is too long for one Discord question. Reduce this operation before requesting approval.';

const operationScope = ({ approval: _approval, ...request }) => canonicalJson(request);
const requestId = dialog => `${MASTERMIND_POT}.${dialog}`;
const EXPIRED = 'discord-admin: the approval is expired or already used, or the guild owner changed. Ask for a new approval.';
const isUnused = prepared => prepared && !prepared.consumed;
const isWithinWindow = (prepared, pick) => prepared.expiresAt > Date.parse(pick.at);

function approvalQuestion(id, request) {
  const scope = operationScope(request);
  const isActivation = request.action === ACTIVATION_ACTION;
  const prompt = isActivation ? 'Install and enable Discord Admin in Mastermind for this guild and application?' : `Apply ${request.action} once, exactly as scoped?`;
  const detail = isActivation ? 'Installs the signed Discord Admin bot using the running Pots gateway.' : 'Applies only this guild, resource and payload, once.';
  return { id, kind: 'question', policy: 'ordinary', scope, context: `Discord Admin asks to apply one exact operation: ${scope}`,
    questions: [{ id: QUESTION, prompt, multiple: false, options: [
      { label: APPROVE, detail, recommended: false },
      { label: DECLINE, detail: 'Nothing changes.', recommended: false }] }] };
}

function registeredPick(record, question) {
  if (!record) return undefined;
  requireRegisteredApproval(record, question);
  const pick = record.picks[QUESTION];
  if (pick && pick.ownerDisplayVerified !== true) throw new Error('discord-admin: the running handler did not verify the owner display. Verify its deployment and register a new question.');
  return pick;
}

function requireRegisteredApproval(record, question) {
  const checks = [record.localAdmin === true, record.registered === true, record.registrationState === 'acknowledged', !record.closed,
    record.registration?.request === requestId(question.id), record.registration?.question.digest === questionDigest(question)];
  if (!checks.every(Boolean)) throw new Error('discord-admin: the approval message is not this exact registered question, or it is closed.');
}

function clickedLabel(pick, { ownerId, guildId }) {
  const [label] = pick.answer.labels;
  if (![pick.answer.labels.length === 1, pick.answer.text === '', [APPROVE, DECLINE].includes(label)].every(Boolean)) throw new Error('discord-admin: the approval answer is not one of its two buttons.');
  if (pick.evidence.guildId !== guildId || pick.evidence.userId !== ownerId) throw new Error('discord-admin: only the server owner\'s click decides this approval. Ask for a new approval.');
  return label;
}

async function prepareApproval(request, ownerId, pending) {
  const id = randomBytes(DIALOG_BYTES).toString('hex');
  const question = approvalQuestion(id, request);
  const shown = questionPacket(question);
  const message = approvalMessage(shown);
  if (message.content.length > DISCORD_MESSAGE_LIMIT) throw new Error(TOO_LONG);
  await pending.locked(({ save }) => save({ id, question, ownerId, expiresAt: Date.now() + APPROVAL_TTL_MS }), id);
  return { status: 'approval_required', approval: id, question: shown, message };
}

async function closeApproval(id, question, answer, clicks) {
  const completion = packet('human.answered', { dialog: id, request: requestId(id), digest: questionDigest(question), status: 'answered', origin: 'discord', answers: [answer] });
  return closeDiscordQuestion(completion, clicks, MASTERMIND_POT).then(() => 'closed', () => 'failed');
}

async function decideApproval(request, ownerId, { pending, clicks, guildId }) {
  return pending.locked(({ get, save }) => {
    const prepared = get(request.approval);
    requirePendingApproval(prepared, ownerId, request);
    const pick = registeredPick(clicks.get(prepared.id), prepared.question);
    if (!pick) {
      if (prepared.expiresAt <= Date.now()) throw new Error(EXPIRED);
      return { status: 'approval_pending', approval: prepared.id };
    }
    if (!isWithinWindow(prepared, pick)) throw new Error(EXPIRED);
    const label = clickedLabel(pick, { ownerId, guildId });
    save({ ...prepared, consumed: { at: new Date().toISOString(), label, evidence: pick.evidence, ownerDisplayVerified: true, handlerPid: pick.handlerPid } });
    return { status: label === APPROVE ? 'authorized' : 'declined', approval: prepared.id, question: prepared.question, answer: pick.answer };
  }, request.approval);
}

function requirePendingApproval(prepared, ownerId, request) {
  if (!isUnused(prepared) || prepared.ownerId !== ownerId) throw new Error(EXPIRED);
  if (prepared.question.scope !== operationScope(request)) throw new Error('discord-admin: the approval covers another guild, resource, action or payload. Ask for a new approval.');
}

async function authorize(request, { ownerId }, dependencies) {
  if (request.approval === undefined) return prepareApproval(request, ownerId, dependencies.pending);
  if (!DIALOG_ID.test(request.approval)) throw new Error('discord-admin: approval must be the dialog ID an earlier request returned.');
  const { question, answer, ...decision } = await decideApproval(request, ownerId, dependencies);
  if (!answer) return decision;
  return { ...decision, discordMessage: await closeApproval(decision.approval, question, answer, dependencies.clicks) };
}

async function verifiedMessage(input, question, api) {
  if (!Array.isArray(input.messages) || input.messages.length !== 1) throw new Error('discord-admin: register one approval display message.');
  const { channelId, messageId } = input.messages[0];
  if (![channelId, messageId].every(snowflake)) throw new Error('discord-admin: invalid approval display message IDs.');
  const bot = await api('GET', '/users/@me');
  const expected = { channelId, messageId, authorId: bot.id, ...approvalMessage(question) };
  requireApprovalDisplay(await api('GET', `/channels/${channelId}/messages/${messageId}`), expected);
  return { ...expected, components: approvalControls(question) };
}

async function registerApproval(input, { pending, clicks, channelAccount, guildId, api, purpose }) {
  const prepared = pendingApproval(input?.dialog, pending);
  if (!isUnused(prepared) || prepared.expiresAt <= Date.now()) throw new Error(EXPIRED);
  const question = questionPacket(prepared.question);
  if (JSON.parse(prepared.question.scope).guildId !== guildId) throw new Error('discord-admin: the registered question belongs to a different guild. Prepare a new question.');
  const message = await verifiedMessage(input, question, api);
  const registration = { question, request: requestId(prepared.id), pot: MASTERMIND_POT, channelAccount, guildId, messages: [message] };
  const record = await registerOwnerQuestion(registration, clicks, prepared.ownerId, purpose);
  return { dialog: record.id, registered: true, state: record.registrationState };
}

function pendingApproval(id, pending) {
  if (!DIALOG_ID.test(id ?? '')) return undefined;
  return pending.get(id);
}

function approvedRequest(id, pending) {
  const prepared = pendingApproval(id, pending);
  if (!prepared) throw new Error('discord-admin: no approval has that dialog ID.');
  return { ...JSON.parse(prepared.question.scope), approval: id };
}

export function approvalWake({ id, purpose }) {
  const instruction = purpose === ACTIVATION_ACTION
    ? `Run the installed discord-admin-activate.mjs apply ${id} command as Mastermind.`
    : `Delegate approve with this ID to ${DISCORD_ADMIN.id}.`;
  return ['--from', DISCORD_ADMIN.id, '--note', `${DISCORD_ADMIN.name} dialog ${id} has a registered click. ${instruction}`];
}

export async function consumedActivation(request, { ownerId, pending, clicks }) {
  const prepared = pendingApproval(request.approval, pending);
  if (!prepared?.consumed) return undefined;
  if (prepared.ownerId !== ownerId) throw new Error(EXPIRED);
  if (request.action !== ACTIVATION_ACTION || prepared.question.scope !== operationScope(request)) throw new Error('discord-admin: the receipt covers a different activation.');
  const { consumed } = prepared;
  if (consumed.ownerDisplayVerified !== true) throw new Error('discord-admin: the receipt lacks the handler display verification. Register a new question.');
  const answer = { id: QUESTION, labels: [consumed.label], text: '' };
  const label = clickedLabel({ answer, evidence: consumed.evidence }, { ownerId, guildId: request.guildId });
  const discordMessage = await closeApproval(prepared.id, prepared.question, answer, clicks);
  return { status: label === APPROVE ? 'authorized' : 'declined', approval: prepared.id, discordMessage };
}

export function discordAdminApprovals(dependencies) {
  return { authorize: (request, identity) => authorize(request, identity, dependencies),
    register: input => registerApproval(input, dependencies), approvedRequest: id => approvedRequest(id, dependencies.pending) };
}
