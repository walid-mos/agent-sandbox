import { exec, run, shared, setShared, appHome, writeTextFile } from "herdr";
import { CONTROL, SANDBOXES } from "./sandboxes.js";

const CHOICE = "pots.sandbox";
const REQUEST_TIMEOUT_MS = 150000;
// exec feeds a program no input, so hc carries a file to the sandbox on its standard input.
const FED = 'exec hc exec --stdin --on "$1" -- node "$2" "$3" "$4"';
const UPLOAD = `${FED} < "$5"`;
// Herdr hands a program text only as an argument or as a file, so typed secrets cross in a file of a private folder.
// The shell unlinks it as soon as it holds it open, then hc reads it from there.
const ANSWERS = "data/pots/answers";
// A file left by a save that Herdr never finished is swept on the next save; a minute keeps a save under way.
const PRIVATE_FOLDER = 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && find "$1" -type f -mmin +1 -delete';
const ANSWER = `exec 3< "$5" && rm -f "$5" && ${FED} <&3`;

let answers = 0;

export const isFromBot = message => message?.person === "bot";

export const failureText = (error, fallback) => error instanceof Error ? error.message : fallback;

export const chosenSandbox = () => SANDBOXES.find(sandbox => sandbox.machine === shared(CHOICE)) ?? SANDBOXES[0];
export const chooseSandbox = sandbox => setShared(CHOICE, sandbox.machine);

async function control(sandbox, ...args) {
  const result = await exec("node", [CONTROL, ...args], { on: sandbox.machine, timeout: REQUEST_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${sandbox.bot} exited ${result.code}.`);
  return result.stdout.trim();
}

export const loadSnapshot = async sandbox => JSON.parse(await control(sandbox, "snapshot"));

export const loadSteps = async (sandbox, sendId) => JSON.parse(await control(sandbox, "activity", sendId));

export const stopWorker = (sandbox, worker) => control(sandbox, "stop-worker", worker.name);

export const sendCommand = (sandbox, request) => control(sandbox, "command", JSON.stringify(request));

/** Answers a blocked worker's question in its own dialog, and resolves to what the worker received. */
export const answerDialog = (sandbox, worker, dialog, answers) => control(sandbox, "answer-dialog", JSON.stringify({ worker, dialog, answers }));

export const openWorker = (sandbox, worker) => run("terminal.peek", { terminal: `${sandbox.machine}/${worker.terminal}` });

/** Runs one control operation that reads the file at `path` on its standard input, through the `shell` that opens it. */
async function controlFed(sandbox, shell, { operation, argument, path, failure }) {
  const result = await exec("sh", ["-c", shell, "sh", sandbox.machine, CONTROL, operation, argument, path], { timeout: REQUEST_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`${failure} ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

const upload = (sandbox, { name, path }) =>
  controlFed(sandbox, UPLOAD, { operation: "attach", argument: name, path, failure: `${name} did not reach ${sandbox.bot}.` });

/** Hands the values typed for one ask-secret to the bot's sandbox, which writes them to the asked file and tells the bot which keys came. */
export async function answerSecret(sandbox, requestId, values) {
  const folder = `${appHome()}/${ANSWERS}`;
  const path = `${folder}/${Date.now()}-${++answers}.json`;
  const prepared = await exec("sh", ["-c", PRIVATE_FOLDER, "sh", folder]);
  if (prepared.code !== 0) throw new Error(`The secrets could not leave: ${prepared.stderr.trim()}`);
  try {
    await writeTextFile(path, JSON.stringify(values), null);
    await controlFed(sandbox, ANSWER, { operation: "answer-secret", argument: requestId, path, failure: `The secrets did not reach ${sandbox.bot}.` });
  }
  finally { await exec("rm", ["-f", path]); }
}

/** Resolves to the id the message has in the conversation. */
export async function sendMessage(sandbox, { id, text, attachments, questionId }) {
  const files = await Promise.all(attachments.map(async attachment => attachment.reference ??= await upload(sandbox, attachment)));
  return control(sandbox, "send", JSON.stringify({ id, text, files, questionId }));
}
