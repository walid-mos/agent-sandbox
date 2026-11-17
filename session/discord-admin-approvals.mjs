import { randomBytes } from 'node:crypto';
import { checkRegistration, closeDiscordQuestion } from './discord-clicks.mjs';
import { DIALOG_ID, MASTERMIND_POT, packet } from './human-contract.mjs';
import { questionDigest, questionPacket } from './human-dialogs.mjs';

export const APPROVE = 'Approve this operation';
export const DECLINE = 'Cancel';
const QUESTION = 'operation';
const DIALOG_BYTES = 16;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const SCOPE_LIMIT = 1400;

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};

export const operationScope = ({ approval: _approval, ...request }) => JSON.stringify(canonical(request));
const requestId = dialog => `${MASTERMIND_POT}.${dialog}`;
const isUnused = prepared => prepared && !prepared.consumed && prepared.expiresAt > Date.now();

function approvalQuestion(id, request) {
  const scope = operationScope(request);
  if (scope.length > SCOPE_LIMIT) throw new Error('discord-admin: approval scope is too long for one Discord question. Reduce this operation before requesting approval.');
  return { id, kind: 'question', policy: 'ordinary', scope, context: `Discord Admin asks to apply one exact operation: ${scope}`,
    questions: [{ id: QUESTION, prompt: `Apply ${request.action} once, exactly as scoped?`, multiple: false, options: [
      { label: APPROVE, detail: 'Applies only this guild, resource and payload, once.', recommended: false },
      { label: DECLINE, detail: 'Nothing changes.', recommended: false }] }] };
}

function registeredPick(record, question) {
  if (!record) return undefined;
  const isOwnRegistration = record.localAdmin === true && record.registered === true && record.registrationState === 'acknowledged'
    && record.registration?.request === requestId(question.id) && record.registration.question.digest === questionDigest(question);
  if (!isOwnRegistration || record.closed) throw new Error('discord-admin: the approval message is not this exact registered question, or it is closed.');
  return record.picks?.[QUESTION];
}

function clickedLabel(pick, { ownerId, guildId }) {
  const [label] = pick.answer.labels;
  if (pick.answer.labels.length !== 1 || pick.answer.text !== '' || ![APPROVE, DECLINE].includes(label)) throw new Error('discord-admin: the approval answer is not one of its two buttons.');
  if (pick.evidence.guildId !== guildId || pick.evidence.userId !== ownerId) throw new Error('discord-admin: only the server owner\'s click decides an irreversible operation. Ask for a new approval.');
  return label;
}

async function prepareApproval(request, ownerId, pending) {
  const id = randomBytes(DIALOG_BYTES).toString('hex');
  const question = approvalQuestion(id, request);
  await pending.locked(({ save }) => save({ id, question, ownerId, expiresAt: Date.now() + APPROVAL_TTL_MS }), id);
  return { status: 'approval_required', approval: id, question: questionPacket(question) };
}

async function closeApproval(id, question, answer, clicks) {
  const completion = packet('human.answered', { dialog: id, request: requestId(id), digest: questionDigest(question), status: 'answered', origin: 'discord', answers: [answer] });
  return closeDiscordQuestion(completion, clicks, MASTERMIND_POT).then(() => 'closed', () => 'failed');
}

async function decideApproval(request, ownerId, { pending, clicks, guildId }) {
  return pending.locked(({ get, save }) => {
    const prepared = get(request.approval);
    if (!isUnused(prepared) || prepared.ownerId !== ownerId) throw new Error('discord-admin: the approval is unknown, expired or already used, or the guild owner changed. Ask for a new approval.');
    if (prepared.question.scope !== operationScope(request)) throw new Error('discord-admin: the approval covers another guild, resource, action or payload. Ask for a new approval.');
    const pick = registeredPick(clicks.get(prepared.id), prepared.question);
    if (!pick) return { status: 'approval_pending', approval: prepared.id };
    const label = clickedLabel(pick, { ownerId, guildId });
    save({ ...prepared, consumed: { at: new Date().toISOString(), label, evidence: pick.evidence } });
    return { status: label === APPROVE ? 'authorized' : 'declined', approval: prepared.id, question: prepared.question, answer: pick.answer };
  }, request.approval);
}

async function authorize(request, { ownerId }, dependencies) {
  if (request.approval === undefined) return prepareApproval(request, ownerId, dependencies.pending);
  if (!DIALOG_ID.test(request.approval)) throw new Error('discord-admin: approval must be the dialog ID an earlier request returned.');
  const { question, answer, ...decision } = await decideApproval(request, ownerId, dependencies);
  if (!answer) return decision;
  return { ...decision, discordMessage: await closeApproval(decision.approval, question, answer, dependencies.clicks) };
}

async function registerApproval(input, { pending, clicks, channelAccount, guildId }) {
  const prepared = DIALOG_ID.test(input?.dialog ?? '') ? pending.get(input.dialog) : undefined;
  if (!isUnused(prepared)) throw new Error('discord-admin: no unused approval has that dialog ID.');
  const registration = { question: questionPacket(prepared.question), request: requestId(prepared.id), pot: MASTERMIND_POT, channelAccount, guildId, messages: input.messages };
  checkRegistration(registration);
  return clicks.locked(({ get, save }) => {
    const existing = get(prepared.id);
    if (existing && JSON.stringify(existing.registration) !== JSON.stringify(registration)) throw new Error('discord-admin: a registration cannot change.');
    const record = existing ?? save({ id: prepared.id, localAdmin: true, ownerId: prepared.ownerId, registration, registrationState: 'acknowledged', registered: true, picks: {} });
    return { dialog: record.id, registered: true, state: record.registrationState };
  }, prepared.id);
}

function approvedRequest(id, pending) {
  const prepared = DIALOG_ID.test(id ?? '') ? pending.get(id) : undefined;
  if (!prepared) throw new Error('discord-admin: no approval has that dialog ID.');
  return { ...JSON.parse(prepared.question.scope), approval: id };
}

export function discordAdminApprovals(dependencies) {
  return { authorize: (request, identity) => authorize(request, identity, dependencies),
    register: input => registerApproval(input, dependencies), approvedRequest: id => approvedRequest(id, dependencies.pending) };
}
