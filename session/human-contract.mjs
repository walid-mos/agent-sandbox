const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SNOWFLAKE = /^\d{17,20}$/;
export const DIALOG_ID = /^[a-f0-9]{32}$/;
export const DIGEST = /^[a-f0-9]{64}$/;
export const RELAYED_POLICIES = ['ordinary', 'push'];
export const LOCAL_POLICY = 'local';
export const policyOf = value => (RELAYED_POLICIES.includes(value) ? value : LOCAL_POLICY);
const NAME = /^[\w-]+$/;
const CAPABILITY = /^[\w-]{43,256}$/;
// Linux Unix socket addresses hold at most 107 path bytes.
const SOCKET_PATH_BYTES = 107;
export const BROWSER_KEY = 'SECRET';
export const SECRET_TTL_MS = 15 * 60 * 1000;
export const VERSION = 1;
export const MASTERMIND_POT = 'mastermind';

const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => new Set(values).size === values.length;
// The pane sends a multiple-choice answer as one picked label per line (herdr/pots-questions.js), so a label holds none.
export const isLabel = label => text(label) && !/[\r\n]/.test(label);
/** An option is its label alone, or `{label, detail, recommended}`. */
export const optionOf = option => (typeof option === 'string' ? { label: option } : option);

export function dialogSource(source) {
  if (source?.type === 'worker' && [source.worker, source.session, source.call].every(text)) return { type: 'worker', worker: source.worker, session: source.session, call: source.call };
  if (source?.type === 'bot' && text(source.message)) return { type: 'bot', message: source.message };
  throw new Error('human: name the worker, session and call, or the bot message.');
}

export function questionsOf(questions) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('human: at least one question is required.');
  const normalized = questions.map(questionOf);
  if (!unique(normalized.map(question => question.id))) throw new Error('human: question IDs must be distinct.');
  return normalized;
}

function questionOf(question) {
  if (!text(question?.id) || !text(question.prompt)) throw new Error('human: each question needs an ID and prompt.');
  const options = (question.options ?? []).map(optionOf);
  if (!options.every(option => isLabel(option?.label)) || !unique(options.map(option => option.label))) {
    throw new Error('human: options need distinct single-line labels.');
  }
  return { id: question.id, prompt: question.prompt, multiple: question.multiple === true,
    options: options.map(({ label, detail, recommended }) => ({ label, detail: typeof detail === 'string' ? detail : '', recommended: recommended === true })) };
}

export function targetOf(target) {
  if (target?.destination === 'pots' && /^[\w-]+\.env$/.test(target.file) && Array.isArray(target.keys) && target.keys.length && target.keys.every(key => KEY.test(key))) {
    return { destination: 'pots', file: target.file, keys: [...new Set(target.keys)] };
  }
  if (target?.destination === 'infisical' && NAME.test(target.projectId) && NAME.test(target.environment) && KEY.test(target.name) && /^\/[^\r\n\0]*$/.test(target.path ?? '/')) {
    return { destination: 'infisical', projectId: target.projectId, environment: target.environment,
      name: target.name, path: target.path ?? '/', replace: target.replace === true };
  }
  if (target?.destination === 'browser' && isExactOrigin(target.origin) && isSocketPath(target.socket) && CAPABILITY.test(target.capability ?? '')) {
    return { destination: 'browser', origin: target.origin, socket: target.socket, capability: target.capability };
  }
  throw new Error('human: secrets require a Pots env file, an Infisical target or a waiting browser tool.');
}

function isExactOrigin(origin) {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
  } catch {
    return false;
  }
}

const isSocketPath = path => typeof path === 'string' && path.startsWith('/') && !/[\r\n\0]/.test(path) && Buffer.byteLength(path) <= SOCKET_PATH_BYTES;

export function targetKeys(target) {
  if (target.destination === 'pots') return target.keys;
  return target.destination === 'browser' ? [BROWSER_KEY] : [target.name];
}

export function onlyFor(question, items, field) {
  const matches = items.filter(item => item?.[field] === question.id);
  return matches.length === 1 ? matches[0] : undefined;
}

export function answersOf(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('human: answer every question.');
  return questions.map(question => answerOf(question, answers));
}

function answerOf(question, answers) {
  const answer = onlyFor(question, answers, 'id');
  const labels = answer?.labels;
  if (!answer || !Array.isArray(labels) || !unique(labels) || typeof answer.text !== 'string') throw new Error('human: invalid answer shape.');
  if (!labels.every(label => question.options.some(option => option.label === label))) throw new Error('human: unknown answer label.');
  const count = labels.length + (answer.text.trim() ? 1 : 0);
  if (count < 1 || (!question.multiple && count !== 1)) throw new Error('human: choose the permitted number of answers.');
  return { id: question.id, labels, text: answer.text };
}

export const isSnowflake = value => SNOWFLAKE.test(value);

export const capture = pattern => `(${pattern.source.slice(1, -1)})`;
const MESSAGE_URL = new RegExp(`^https://discord\\.com/channels/${capture(SNOWFLAKE)}/${capture(SNOWFLAKE)}/${capture(SNOWFLAKE)}$`);

export const discordMessageUrl = ({ guildId, channelId, messageId }) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

export function discordMessage(messageUrl) {
  const link = MESSAGE_URL.exec(messageUrl ?? '');
  if (!link) throw new Error('human: provide the originating Discord message link.');
  return { guildId: link[1], channelId: link[2], messageId: link[3] };
}

export function checkDiscordPolicy(policy, identity) {
  if (policy !== 'push') return;
  if (identity?.pushApprovalsEnabled !== true || !SNOWFLAKE.test(identity.userId)) throw new Error('human: Discord push approvals stay off until merged and verified live.');
}

export function discordEvidence(evidence, identity, policy) {
  checkDiscordPolicy(policy, identity);
  const message = discordMessage(evidence?.messageUrl);
  if (!SNOWFLAKE.test(evidence?.userId) || message.guildId !== evidence.guildId || !Number.isFinite(Date.parse(evidence?.at))) throw new Error('human: Discord answer has no valid click metadata.');
  if (policy === 'push' && evidence.userId !== identity.userId) throw new Error("human: this push needs the configured operator's own click.");
  return { userId: evidence.userId, guildId: evidence.guildId, messageUrl: evidence.messageUrl, at: evidence.at };
}

export const closedDialogText = dialog => `${dialog.kind === 'secret' ? 'Secret request' : 'Question'} ${dialog.result.status}.`;

export const answerParts = answer => [...answer.labels, answer.text].filter(Boolean);
export const answerText = answers => answers.map(answer => answerParts(answer).join('\n')).join('\n');
export const packet = (type, fields) => ({ type, version: VERSION, ...fields });
