import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parsedLine } from './jsonl.mjs';
import { command } from './run.mjs';

// The Pi harness publishes the interactive session's file under this terminal label.
const SESSION_LABEL = 'pi.session';
const QUESTION_TOOL = 'ask_user_question';
const SECRET_TOOL = 'ask_user_secret';
const DIALOG_TOOLS = new Set([QUESTION_TOOL, SECRET_TOOL]);
const RESULT_WAIT_MS = 15_000;
const RESULT_POLL_MS = 250;
// hc wraps what a terminal's program sends in a tag naming that terminal; the answer is the person's, so it leaves untagged.
const UNTAGGED = { env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'HC_TERMINAL_ID')) };

const sessionLines = path => readFileSync(path, 'utf8').split('\n');

/** Pi's entries from the newest back, parsed only as far as the caller reads. */
function* newestEntries(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) yield* parsedLine(lines[index]);
}

// A dialog blocks the turn, so the assistant message that opened it is the newest one, and its result is not written yet.
function openCall(lines) {
  const answered = new Set();
  for (const { type, message } of newestEntries(lines)) {
    if (type !== 'message') continue;
    if (message.role === 'toolResult') answered.add(message.toolCallId);
    if (message.role === 'assistant') return message.content.find(part => part.type === 'toolCall' && DIALOG_TOOLS.has(part.name) && !answered.has(part.id));
  }
  return undefined;
}

// Discuss pauses a questionnaire, and Pi reopens a later call asking the same questions on the answers and drafts it
// paused with, where keys counted from a fresh dialog would land on the wrong question. Pi keys that state by the
// questions as it normalizes them, and drops it when a call with that key completes: so the dialog may be resumed when,
// among earlier calls with the same question ids, the newest result of some exact set of questions is a pause.
const questionIds = ({ arguments: { questions } = {} }) => (Array.isArray(questions) ? JSON.stringify(questions.map(question => `${question?.id}`.trim())) : '');

function hasPausedAnswers(lines, call) {
  const asked = questionIds(call);
  const results = new Map();
  const seen = new Set();
  for (const { type, message } of newestEntries(lines.filter(line => line.includes(QUESTION_TOOL)))) {
    if (type !== 'message') continue;
    if (message.role === 'toolResult') results.set(message.toolCallId, message);
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall' || part.name !== QUESTION_TOOL || !results.has(part.id) || questionIds(part) !== asked) continue;
      const questions = JSON.stringify(part.arguments.questions);
      if (seen.has(questions)) continue;
      seen.add(questions);
      const paused = results.get(part.id).details?.chat?.initialState;
      if (paused && (paused.answers?.length || Object.keys(paused.drafts ?? {}).length)) return true;
    }
  }
  return false;
}

function resultOf(lines, callId) {
  for (const { type, message } of newestEntries(lines)) {
    if (type === 'message' && message.role === 'toolResult' && message.toolCallId === callId) {
      return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    }
  }
  return undefined;
}

// Pi's dialog takes a question without options as open, whatever its multiSelect says.
function questionView({ prompt, options = [], multiSelect = false }) {
  return {
    prompt,
    options: options.map(({ label, description = '', recommended = false }) => ({ label, description, isRecommended: recommended })),
    isMultiple: options.length > 0 && multiSelect === true,
  };
}

function dialogOf(terminal) {
  const { labels, status } = JSON.parse(command('hc', ['get', terminal.address]));
  const session = labels?.[SESSION_LABEL];
  const lines = session ? sessionLines(session) : [];
  const call = openCall(lines);
  return { session, call, isResumed: call?.name === QUESTION_TOOL && hasPausedAnswers(lines, call), message: status?.msg ?? '' };
}

/** What a blocked worker waits for: a question the pane can answer, one resumed that only its terminal can finish,
 *  a secret, or another dialog only its terminal shows. */
export function waitingDialog(terminal) {
  try {
    const { call, isResumed, message } = dialogOf(terminal);
    if (isResumed) return { id: call.id, kind: 'resumed' };
    if (call?.name === QUESTION_TOOL) return { id: call.id, kind: 'question', questions: call.arguments.questions.map(questionView) };
    if (call?.name === SECRET_TOOL) return { id: call.id, kind: 'secret', purpose: call.arguments.purpose };
    return { id: '', kind: 'other', message };
  } catch (error) {
    return { id: '', kind: 'other', message: `Its dialog could not be read: ${error.message}` };
  }
}

function invalidAnswer(question, { choices, text }) {
  const { options, isMultiple } = question;
  const isChoice = index => Number.isInteger(index) && index >= 0 && index < options.length;
  if (!Array.isArray(choices) || typeof text !== 'string' || !choices.every(isChoice) || new Set(choices).size !== choices.length) return true;
  if (!options.length) return choices.length > 0 || !text.trim();
  if (isMultiple) return !choices.length && !text.trim();
  return choices.length + (text.trim() ? 1 : 0) !== 1;
}

const downs = count => Array(count).fill('down');

/**
 * The keys that answer one question from where its tab opens: up to the first option, down through the options,
 * and the free answer pasted on the row after them. A question without options opens on its free answer.
 */
function answerSteps({ options, isMultiple }, { choices, text }) {
  const typed = text.trim();
  if (!options.length) return [{ text: typed }];
  const top = Array(options.length + 1).fill('up');
  if (!isMultiple && !typed) return [{ keys: [...top, ...downs(choices[0]), 'enter'] }];
  const picked = choices.toSorted((first, second) => first - second);
  const toggles = picked.flatMap((index, order) => [...downs(index - (picked[order - 1] ?? 0)), 'space']);
  const last = picked.at(-1) ?? 0;
  if (!typed) return [{ keys: [...top, ...toggles, 'enter'] }];
  return [{ keys: [...top, ...toggles, ...downs(options.length - last)] }, { text: typed }];
}

// Keys start from the question as it opened, so a call that already took keys, even ones that never settled, takes no more.
function claimCall(callId) {
  const marker = join(tmpdir(), `pots-answered-${createHash('sha256').update(callId).digest('hex').slice(0, 16)}`);
  try {
    writeFileSync(marker, '', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('pots: that question already took an answer that did not settle. Open its terminal to finish there.');
  }
}

function press(terminal, { keys, text }) {
  if (keys) command('hc', ['keys', terminal.address, ...keys]);
  else command('hc', ['send', '--force', '--', terminal.address, text], UNTAGGED);
}

async function settledResult(session, callId) {
  const deadline = Date.now() + RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    const result = resultOf(sessionLines(session), callId);
    if (result !== undefined) return result;
    await delay(RESULT_POLL_MS);
  }
  throw new Error('pots: the worker still shows its question. Open its terminal to answer there.');
}

/**
 * Answers the worker's open question in its own dialog, with the keys a person would press, and resolves to what
 * the worker received. `answers` holds one `{ choices, text }` per question: option indexes and a free answer.
 */
export async function answerDialog(terminal, { dialog, answers }) {
  const { session, call, isResumed } = dialogOf(terminal);
  if (call?.name !== QUESTION_TOOL || call.id !== dialog) throw new Error('pots: the worker no longer asks that question. Refresh the worker list.');
  if (isResumed) throw new Error('pots: that question was begun in the worker\'s terminal. Finish it there.');
  const questions = call.arguments.questions.map(questionView);
  if (!Array.isArray(answers) || answers.length !== questions.length || questions.some((question, index) => invalidAnswer(question, answers[index]))) {
    throw new Error('pots: answer each question with one option, its own answer, or for a multiple choice at least one of them.');
  }
  const steps = questions.flatMap((question, index) => answerSteps(question, answers[index]));
  // Several questions end on the dialog's submit tab, which Enter submits once every question has its answer.
  const submit = questions.length > 1 ? [{ keys: ['enter'] }] : [];
  claimCall(call.id);
  [...steps, ...submit].forEach(step => press(terminal, step));
  return settledResult(session, call.id);
}
