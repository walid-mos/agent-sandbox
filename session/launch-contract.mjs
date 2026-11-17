import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assignments } from './environment.mjs';
import { DIALOG_ID, DIGEST, discordMessage, packet, text, VERSION } from './human-contract.mjs';
import { isPotName } from './door-messages.mjs';

export const LAUNCH_TTL_MS = 30 * 60 * 1000;
// A Mac's clock may trail Discord's or a pot's by this much, so a press or a request stamped slightly ahead of the Mac still counts.
export const CLOCK_SKEW_MS = 5000;
const PROMPT_BYTES = 12_000;
export const REPORT_CHARACTERS = 8000;
const LINE_CHARACTERS = 100;
const DETAIL_CHARACTERS = 500;
export const OPEN = 'open';
export const OFFERED = 'offered';
export const STARTED = 'started';
export const EXPIRED = 'expired';
export const STATUSES = [OFFERED, STARTED, 'finished', 'refused', EXPIRED, 'superseded', 'cancelled', 'failed'];
export const isTarget = isPotName;
export const LAUNCH_SCRIPT = `${assignments(readFileSync(new URL('./launch.env', import.meta.url), 'utf8')).POTS_SESSION_REPOSITORY}/session/mac-launch.mjs`;
// Line feed and tab are the only characters a reader cannot see that a prompt may hold. The listed letters render as blanks.
const UNSEEN = /[^\P{C}\n\t]|[\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800]/u;

export const ACTS = {
  'sign-tip': { label: 'sign a commit or a tip that pots then run', marks: /\bvm-trust\b|\bgpg\b|\bcommit\b[^\n]*\s-S\b|\bsign(?:s|ed|ing)?\b[^\n]{0,60}\b(?:tip|main|commit)\b/i },
  'launch-gate': { label: 'change this gate, its settings, its token or its service', marks: /launch-gate|mac-launch|macLaunch|(?:mac|session)\/launch-/i },
  'vm-up': { label: 'run vm-up or vm-config, which change a pot VM\'s root side', marks: /\bvm-(?:up|config)\b/ },
  'restart-pot': { label: 'restart or stop a pot, its session or its services', marks: /\bsession-bootstrap\b|\bpots-session\b|\bcolima\s+(?:stop|restart|delete)\b|\b(?:restart|reboot|stop)(?:s|ed|ing)?\b[^\n]{0,60}\b(?:pots?|session|gateway|VM)\b/i },
  spend: { label: 'create or resume paid machines or services', marks: /\bboat\s+(?:create|resume|fork)\b|--cloud\b/ },
  publish: { label: 'push, merge, release or deploy', marks: /\bgit\s+push\b|\bgh\s+pr\s+(?:merge|ready)\b|\b(?:deploy|release|publish)(?:s|ed|ing)?\b/i },
  credentials: { label: 'create, rotate, move or print credentials', marks: /\bsession-credentials\b|\btailnet-key\b|\bsecurity\s+(?:find|add|delete)-generic-password\b|\b(?:rotate|mint|print|copy|export)(?:s|ed|ing)?\b[^\n]{0,60}\b(?:token|secret|credential|password|key)s?\b/i },
};
export const DEFAULT_REFUSED_ACTS = ['sign-tip', 'launch-gate'];

const REQUEST_FIELDS = ['launch', 'pot', 'target', 'title', 'digest', 'acts', 'cost', 'createdAt', 'expiresAt'];
const NOTICE_FIELDS = ['launch', 'pot', 'target'];
const STATUS_FIELDS = ['launch', 'target', 'digest', 'status', 'detail', 'messageUrl', 'report'];
const NOTICE_BLOCK = /\n\n```mac-launch\n([^\n]+)\n```$/;

const isAct = act => Object.hasOwn(ACTS, act);
const promptDigest = prompt => createHash('sha256').update(prompt, 'utf8').digest('hex');
// A combining or ignorable character renders as nothing, so the scan reads the text without them and an act name cannot hide behind one.
const BLANK = /[\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}]/gu;
const namedActs = parts => Object.keys(ACTS).filter(act => ACTS[act].marks.test(parts.join('\n').replace(BLANK, '')));
const isLine = value => typeof value === 'string' && value.length <= LINE_CHARACTERS && value === value.trim() && !UNSEEN.test(value) && !/[\n\t]/.test(value);

function exactFields(candidate, type, fields) {
  const isPacket = candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate.type === type && candidate.version === VERSION;
  if (!isPacket || Object.keys(candidate).some(key => !['type', 'version', ...fields].includes(key))) throw new Error(`mac-launch: this is not a ${type} packet of version ${VERSION}.`);
}

function checkPrompt(prompt) {
  if (!text(prompt)) throw new Error('mac-launch: the prompt is empty. Write what the Mac agent must do.');
  if (/^[@/]/.test(prompt)) throw new Error('mac-launch: Pi reads a leading @ as a file and a leading / as one of its own commands, so the run would not be the prompt shown. Start the prompt with a sentence.');
  const size = Buffer.byteLength(prompt);
  if (size > PROMPT_BYTES) throw new Error(`mac-launch: the prompt is ${size} bytes and a launch takes ${PROMPT_BYTES}. Shorten it.`);
  const unseen = UNSEEN.exec(prompt);
  if (!unseen) return;
  const code = unseen[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  throw new Error(`mac-launch: the prompt holds U+${code} at character ${unseen.index}, which a reader cannot see. Remove it.`);
}

function checkActs({ acts, title, cost }, prompt) {
  if (!Array.isArray(acts) || !acts.every(isAct) || new Set(acts).size !== acts.length) throw new Error(`mac-launch: acts must be distinct names among ${Object.keys(ACTS).join(', ')}.`);
  const undeclared = namedActs([title, cost, prompt]).filter(act => !acts.includes(act));
  if (undeclared.length) throw new Error(`mac-launch: the request names ${undeclared.join(', ')} and does not declare it. Declare each privileged act it asks for.`);
}

function checkRequest(request, prompt) {
  const { launch, pot, target, title, digest, cost, createdAt, expiresAt } = request;
  if (!DIALOG_ID.test(launch) || !isPotName(pot) || !isTarget(target)) throw new Error('mac-launch: a request names its launch, its pot and its target Mac.');
  if (!isLine(title) || !title || !isLine(cost)) throw new Error(`mac-launch: the title and the cost are each one visible line of at most ${LINE_CHARACTERS} characters, and the title is not empty.`);
  if (!Number.isSafeInteger(createdAt) || expiresAt !== createdAt + LAUNCH_TTL_MS) throw new Error('mac-launch: a request lives exactly its fixed time from its creation.');
  checkPrompt(prompt);
  if (!DIGEST.test(digest) || digest !== promptDigest(prompt)) throw new Error('mac-launch: the digest is not the SHA-256 of the prompt bytes.');
  checkActs(request, prompt);
}

export function launchRequest({ launch, pot, target, title, acts = [], cost = '', createdAt, prompt }) {
  const request = packet('mac.launch-request', { launch, pot, target, title, digest: text(prompt) ? promptDigest(prompt) : undefined, acts, cost, createdAt, expiresAt: createdAt + LAUNCH_TTL_MS });
  checkRequest(request, prompt);
  return request;
}

export const sameRequest = (first, second) => ['type', 'version', ...REQUEST_FIELDS].every(key => JSON.stringify(first[key]) === JSON.stringify(second[key]));

export const shownRequest = (request, prompt, state) => ({ ...request, state, prompt });

export function fetchedRequest(shown) {
  exactFields(shown, 'mac.launch-request', [...REQUEST_FIELDS, 'state', 'prompt']);
  const { state, prompt, ...request } = shown;
  if (state !== OPEN && !STATUSES.includes(state)) throw new Error('mac-launch: the pot gave no known state for this launch.');
  checkRequest(request, prompt);
  return { request, prompt, state };
}

export const launchNotice = ({ launch, pot, target }) => packet('mac.launch-notice', { launch, pot, target });
export const noticeText = notice => `Post this Mac launch notice with node ${LAUNCH_SCRIPT} announce and this door request ID. Target ${notice.target}, pot ${notice.pot}.\n\n\`\`\`mac-launch\n${JSON.stringify(notice)}\n\`\`\``;

export function noticeOf(content) {
  const block = NOTICE_BLOCK.exec(content ?? '');
  let notice;
  try { notice = JSON.parse(block?.[1]); } catch { throw new Error('mac-launch: this text holds no launch notice.'); }
  exactFields(notice, 'mac.launch-notice', NOTICE_FIELDS);
  const isNamed = DIALOG_ID.test(notice.launch) && isPotName(notice.pot) && isTarget(notice.target);
  if (!isNamed || noticeText(launchNotice(notice)) !== content) throw new Error('mac-launch: a launch notice holds its fixed text and nothing else.');
  return notice;
}

export function launchStatus({ launch, target, digest, status, detail = '', messageUrl, report }) {
  return checkedStatus(packet('mac.launch-status', { launch, target, digest, status, detail: detail.slice(0, DETAIL_CHARACTERS), messageUrl, report: report?.slice(0, REPORT_CHARACTERS) }));
}

export function checkedStatus(status) {
  exactFields(status, 'mac.launch-status', STATUS_FIELDS);
  const { launch, target, digest, detail, messageUrl, report } = status;
  const isNamed = DIALOG_ID.test(launch) && isTarget(target) && DIGEST.test(digest) && STATUSES.includes(status.status);
  const isBounded = typeof detail === 'string' && detail.length <= DETAIL_CHARACTERS && (report === undefined || (typeof report === 'string' && report.length <= REPORT_CHARACTERS));
  if (!isNamed || !isBounded) throw new Error('mac-launch: a status names its launch, target, digest and one known status, within its size limits.');
  if (messageUrl !== undefined) discordMessage(messageUrl);
  return status;
}
