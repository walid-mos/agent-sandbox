import { randomBytes } from 'node:crypto';
import { closeDiscordQuestion, registerOwnerQuestion } from './discord-clicks.mjs';
import { DIALOG_ID, MASTERMIND_POT, packet } from './human-contract.mjs';
import { questionDigest, questionPacket } from './human-dialogs.mjs';
import { approvalMessage, canonicalJson, DISCORD_MESSAGE_LIMIT, requireApprovalDisplay } from './discord-admin-message.mjs';
import { snowflake } from './discord-admin-operations.mjs';

export const DISCORD_ADMIN = { id: 'discord-admin', name: 'Discord Admin' };
export const APPROVE = 'Approve this operation';
export const DECLINE = 'Cancel';
const QUESTION = 'operation';
const DIALOG_BYTES = 16;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const TOO_LONG = 'discord-admin: approval scope is too long for one Discord question. Reduce this operation before requesting approval.';

const operationScope = ({ approval: _approval, ...request }) => canonicalJson(request);
const requestId = dialog => `${MASTERMIND_POT}.${dialog}`;
const isUnused = prepared => prepared && !prepared.consumed && prepared.expiresAt > Date.now();

function approvalQuestion(id, request) {
  const scope = operationScope(request);
  return { id, kind: 'question', policy: 'ordinary', scope, context: `Discord Admin asks to apply one exact operation: ${scope}`,
    questions: [{ id: QUESTION, prompt: `Apply ${request.action} once, exactly as scoped?`, multiple: false, options: [
      { label: APPROVE, detail: 'Applies only this guild, resource and payload, once.', recommended: false },
      { label: DECLINE, detail: 'Nothing changes.', recommended: false }] }] };
}

function registeredPick(record, question) {
  if (!record) return undefined;
  requireRegisteredApproval(record, question);
  return record.picks[QUESTION];
}

function requireRegisteredApproval(record, question) {
  const registration = record.registration ?? { question: {} };
  const checks = [record.localAdmin === true, record.registered === true, record.registrationState === 'acknowledged', !record.closed,
    registration.request === requestId(question.id), registration.question.digest === questionDigest(question)];
  if (!checks.every(Boolean)) throw new Error('discord-admin: the approval message is not this exact registered question, or it is closed.');
}

function clickedLabel(pick, { ownerId, guildId }) {
  const [label] = pick.answer.labels;
  if (![pick.answer.labels.length === 1, pick.answer.text === '', [APPROVE, DECLINE].includes(label)].every(Boolean)) throw new Error('discord-admin: the approval answer is not one of its two buttons.');
  if (pick.evidence.guildId !== guildId || pick.evidence.userId !== ownerId) throw new Error('discord-admin: only the server owner\'s click decides an irreversible operation. Ask for a new approval.');
  return label;
}

async function prepareApproval(request, ownerId, pending) {
  const id = randomBytes(DIALOG_BYTES).toString('hex');
  const question = approvalQuestion(id, request);
  const shown = questionPacket(question);
  const message = approvalMessage(shown, 'disabled');
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
    if (!pick) return { status: 'approval_pending', approval: prepared.id };
    const label = clickedLabel(pick, { ownerId, guildId });
    save({ ...prepared, consumed: { at: new Date().toISOString(), label, evidence: pick.evidence } });
    return { status: label === APPROVE ? 'authorized' : 'declined', approval: prepared.id, question: prepared.question, answer: pick.answer };
  }, request.approval);
}

function requirePendingApproval(prepared, ownerId, request) {
  if (!isUnused(prepared) || prepared.ownerId !== ownerId) throw new Error('discord-admin: the approval is unknown, expired or already used, or the guild owner changed. Ask for a new approval.');
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
  const expected = { channelId, messageId, authorId: bot.id, ...approvalMessage(question, 'disabled') };
  requireApprovalDisplay(await api('GET', `/channels/${channelId}/messages/${messageId}`), expected);
  return { ...expected, components: approvalMessage(question, 'enabled').components };
}

async function registerApproval(input, { pending, clicks, channelAccount, guildId, api }) {
  const prepared = pendingApproval(input?.dialog, pending);
  if (!isUnused(prepared)) throw new Error('discord-admin: no unused approval has that dialog ID.');
  const question = questionPacket(prepared.question);
  const message = await verifiedMessage(input, question, api);
  const registration = { question, request: requestId(prepared.id), pot: MASTERMIND_POT, channelAccount, guildId, messages: [message] };
  const record = await registerOwnerQuestion(registration, clicks, prepared.ownerId);
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

export const approvalWake = dialog => ['--from', DISCORD_ADMIN.id, '--note', `${DISCORD_ADMIN.name} dialog ${dialog} has a registered click. Delegate approve with this ID to ${DISCORD_ADMIN.id}. The command rechecks the exact operation and consumes it once.`];

export function discordAdminApprovals(dependencies) {
  return { authorize: (request, identity) => authorize(request, identity, dependencies),
    register: input => registerApproval(input, dependencies), approvedRequest: id => approvedRequest(id, dependencies.pending) };
}
