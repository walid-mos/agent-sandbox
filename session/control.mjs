import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { botModel, runCommand } from './commands.mjs';
import { answerBotQuestion, storeBotSecret, syncBotDialogs } from './human-bot.mjs';
import { main } from './main.mjs';
import { questionIn } from './pots-questions.mjs';
import { conversation, isFromBot, say, secretRequests, TERMINAL } from './terminal-conversation.mjs';
import { queued } from './queue.mjs';
import { commandOutput } from './run.mjs';
import { botId } from './sandbox.mjs';
import { endTerminal, isStopped, liveTerminals, markStopped, terminalOf, WORKER_PREFIX, workers } from './workers.mjs';
import { answerDialog, waitingDialog } from './worker-dialogs.mjs';

const MESSAGE_LIMIT = 80;
const TRACE_LIMIT = '8';
const ATTACHMENTS = 'files';
const ATTACHMENT_DAYS = 30;
const DAY_MS = 86_400_000;
const STANDARD_INPUT = 0;
const SEND_ID = /^[\w:.]+$/;
// `pots trace` draws each tool call as `tool <name> call → <outcome>  +<start>  <duration>`.
const TOOL_STEP = /─ tool (\S+) \S+ → (\S+)(?: \(resumed\))? {2}\+\S+ \S+ {2}(.+)$/;
const MODEL_STEP = /─ model /;

async function section(arguments_) {
  try {
    return await commandOutput('pots', arguments_);
  } catch (error) {
    const reason = `${error?.stderr ?? ''}`.trim().split('\n')[0];
    return `Unavailable. ${reason || 'pots did not answer.'}`;
  }
}

function messageView(record, requests) {
  const { id, at, person, text, files = [], send_id = null } = record;
  const request = requests.get(id);
  const secret = request?.isOpen ? { file: request.secret.file, keys: request.secret.keys } : null;
  const asked = (isFromBot(record) && questionIn(text)) || { text, question: null };
  return { id, at, person, ...asked, files: files.map(file => file.name), sendId: send_id, secret, isSecretReply: Boolean(record.answers) };
}

function recentMessages() {
  const records = conversation();
  const requests = secretRequests(records);
  const messages = records.filter(record => record.type === 'message');
  // An open request for secrets stays however old, so the pane can still answer it.
  return messages.filter((record, index) => index >= messages.length - MESSAGE_LIMIT || requests.get(record.id)?.isOpen)
    .map(record => messageView(record, requests));
}

// `pots status` prints `<bot>: <name>, <model>, working|idle, …` for a running bot and `<bot>: not running` otherwise.
// Anything else, such as the line a failed pots answers with, says nothing about the bot.
function activityIn(status) {
  const line = status.split('\n').find(row => row.startsWith(`${botId}: `)) ?? '';
  if (line.includes(', working, ')) return 'working';
  if (line.includes(', idle, ')) return 'idle';
  return line.endsWith(': not running') ? 'offline' : 'unknown';
}

async function snapshot() {
  // The pots sections run while the worker rows are built from hc's terminals.
  const sections = Promise.all([
    section(['status']),
    section(['children', '--bot', botId]),
    section(['routine', 'list', '--bot', botId]),
    section(['trace', '--bot', botId, '--last', TRACE_LIMIT]),
  ]);
  const terminals = liveTerminals();
  const waiting = new Set(queued().map(request => request.worker));
  const rows = workers().map(worker => {
    const terminal = terminalOf(worker, terminals);
    const isQueued = !terminal && waiting.has(worker.name);
    const status = isStopped(worker) ? 'offline' : terminal?.status ?? (isQueued ? 'starting' : worker.status ?? 'starting');
    const dialog = status === 'blocked' && terminal ? waitingDialog(terminal) : null;
    return { ...worker, title: worker.name.slice(WORKER_PREFIX.length), terminal: terminal?.address ?? null, status, dialog, isQueued };
  });
  const [status, children, routines, trace] = await sections;
  return {
    bot: { model: botModel(), activity: activityIn(status) },
    status, messages: recentMessages(), workers: rows, children, routines, trace,
  };
}

function workerNamed(name) {
  const worker = workers().find(item => item.name === name);
  if (!worker) throw new Error('pots: unknown worker. Refresh the worker list.');
  return worker;
}

function stopWorker(name) {
  const worker = workerNamed(name);
  markStopped(worker);
  endTerminal(worker, liveTerminals());
}

/** Answers a blocked worker's question in its own dialog, and resolves to what the worker received. */
function answerWorker(request) {
  const { worker: name, dialog, answers } = JSON.parse(request);
  const terminal = terminalOf(workerNamed(name), liveTerminals());
  if (!terminal) throw new Error('pots: that worker has no live terminal. Refresh the worker list.');
  return answerDialog(terminal, { dialog, answers });
}

function removeExpired(folder) {
  const oldest = Date.now() - ATTACHMENT_DAYS * DAY_MS;
  readdirSync(folder).map(name => join(folder, name))
    .filter(path => statSync(path).mtimeMs < oldest)
    .forEach(path => rmSync(path, { recursive: true }));
}

// Each file gets its own folder, so it keeps its name and two never share a path.
function attach(name) {
  const content = readFileSync(STANDARD_INPUT);
  if (!content.length) throw new Error('pots: the file came empty. Attach it again.');
  const own = join(ATTACHMENTS, randomUUID());
  mkdirSync(join(TERMINAL, own), { recursive: true });
  removeExpired(join(TERMINAL, ATTACHMENTS));
  const reference = join(own, basename(name));
  writeFileSync(join(TERMINAL, reference), content);
  return reference;
}

function attached(reference) {
  const path = resolve(TERMINAL, `${reference}`);
  if (!path.startsWith(join(TERMINAL, ATTACHMENTS) + sep) || !existsSync(path)) {
    throw new Error(`pots: no attached file at ${reference}. Attach it again.`);
  }
  return { name: basename(path), url: reference, size: statSync(path).size };
}

// pots chat waits for the answer, so this writes the record its terminal channel reads, as pots chat does.
// One written while the bot is down waits there until it starts. The pane names the message, so a Retry after a lost
// answer writes nothing twice.
async function send(request) {
  const { id = `m-${randomUUID()}`, text = '', files = [], questionId } = JSON.parse(request);
  if (!Array.isArray(files) || (!`${text}`.trim() && !files.length)) {
    throw new Error('pots: send needs {"id", "text", "files"} with some text or at least one attached file.');
  }
  if (conversation().some(record => record.id === id)) return id;
  await syncBotDialogs();
  const latest = conversation().at(-1);
  const message = questionId ?? (isFromBot(latest) && questionIn(latest.text) && !files.length ? latest.id : undefined);
  if (!message) return say({ id, text: `${text}`, ...(files.length && { files: files.map(attached) }) });
  return answerBotQuestion(message, `${text}`, id);
}

/** Answers one ask-secret as `pots chat` does, so the bot wakes on the same message and learns only which keys came. */
async function answerSecret(requestId) {
  const request = secretRequests(conversation()).get(requestId);
  if (!request) throw new Error(`pots: ${requestId} asks for no secret. Refresh the conversation.`);
  if (!request.isOpen) throw new Error('pots: that request for secrets has its answer already.');
  await syncBotDialogs();
  let values;
  try { values = JSON.parse(readFileSync(STANDARD_INPUT, 'utf8')); } catch { throw new Error('pots: unreadable secret input.'); }
  return storeBotSecret(requestId, values);
}

const SENT_BY = sendId => new RegExp(` send=${sendId}(?: |$)`);

/** The model calls and tool calls of the run that sent a reply, after the reply before it in that run. */
async function activity(sendId) {
  if (!SEND_ID.test(`${sendId}`)) throw new Error(`pots: ${sendId} is no send ID. Refresh the conversation.`);
  const lines = (await commandOutput('pots', ['trace', '--bot', botId, sendId])).split('\n').map(line => line.trimEnd());
  const sentBy = SENT_BY(sendId);
  const anySend = SENT_BY('\\S+');
  const sent = lines.findIndex(line => sentBy.test(line));
  if (sent < 0) throw new Error(`pots: the trace of ${sendId} has no reply. pots keeps traces for 7 days.`);
  const steps = lines.slice(lines.slice(0, sent).findLastIndex(line => anySend.test(line)) + 1, sent);
  const tools = steps.flatMap(line => {
    const step = TOOL_STEP.exec(line);
    return step && step[1] !== 'send' ? [{ tool: step[1], outcome: step[2], duration: step[3] }] : [];
  });
  return { modelCalls: steps.filter(line => MODEL_STEP.test(line)).length, tools };
}

/** Runs /model or /route for the bot, or for the worker the pane names. */
function command(request) {
  const { name, worker = null, argument = '' } = JSON.parse(request);
  return runCommand({ name, worker: worker && workerNamed(worker), argument });
}

const OPERATIONS = {
  snapshot: { usage: '', run: async () => JSON.stringify(await snapshot()) },
  send: { usage: 'json', run: send },
  attach: { usage: 'name <file', run: attach },
  'answer-secret': { usage: 'request-id <json', run: answerSecret },
  activity: { usage: 'send-id', run: async sendId => JSON.stringify(await activity(sendId)) },
  'stop-worker': { usage: 'name', run: name => { stopWorker(name); return ''; } },
  command: { usage: 'json', run: command },
  'answer-dialog': { usage: 'json', run: answerWorker },
};

const USAGE = Object.entries(OPERATIONS).map(([name, { usage }]) => [name, usage].filter(Boolean).join(' ')).join('|');

main(import.meta, async () => {
  const [operation, argument] = process.argv.slice(2);
  if (!Object.hasOwn(OPERATIONS, operation) || (OPERATIONS[operation].usage && !argument?.trim())) {
    throw new Error(`usage: control.mjs ${USAGE}`);
  }
  process.stdout.write(await OPERATIONS[operation].run(argument));
});
