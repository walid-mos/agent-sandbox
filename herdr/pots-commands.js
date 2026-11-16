import { sendCommand } from "./pots-source.js";

const COMMANDS = new Set(["model", "route"]);
const COMMAND_LINE = /^\/(\w+)(?:[ \t]+(.*))?$/;
const AIM = "@";

const fieldsOf = worker => [worker.title, worker.name, worker.branch].map(field => `${field ?? ""}`.toLowerCase());

/** The worker `@aim` names: one whose title, name or branch it is, otherwise the only one whose fields hold it. */
function aimedWorker(aim, workers) {
  if (!aim) return { worker: null, error: `Name a worker's branch after ${AIM}.` };
  const needle = aim.toLowerCase();
  const exact = workers.filter(worker => fieldsOf(worker).includes(needle));
  const matches = exact.length ? exact : workers.filter(worker => fieldsOf(worker).some(field => field.includes(needle)));
  if (matches.length === 1) return { worker: matches[0], error: "" };
  const error = matches.length
    ? `${AIM}${aim} matches ${matches.map(worker => worker.title).join(", ")}. Type more of one.`
    : `No worker matches ${AIM}${aim}.`;
  return { worker: null, error };
}

/**
 * The pane command a draft holds, or null when the draft goes as a message: an unknown command, a second line or an
 * attached file makes it one. `/model @branch max` aims at a worker; without `@` the command is for the bot.
 */
export function commandIn(draft, workers) {
  if (draft.attachments.length) return null;
  const match = COMMAND_LINE.exec(draft.text.trim());
  if (!match || !COMMANDS.has(match[1])) return null;
  const words = (match[2] ?? "").split(/\s+/).filter(Boolean);
  const isAimed = words[0]?.startsWith(AIM) ?? false;
  const argument = (isAimed ? words.slice(1) : words).join(" ");
  const target = isAimed ? aimedWorker(words[0].slice(AIM.length), workers) : { worker: null, error: "" };
  return { name: match[1], argument, ...target };
}

/** What Enter does with the command, so the person sees who it reaches before it leaves. */
export function commandHint(command, bot) {
  if (command.error) return { text: command.error, isError: true };
  const line = [`/${command.name}`, command.argument].filter(Boolean).join(" ");
  const text = command.worker
    ? `Enter runs ${line} for the worker on ${command.worker.branch}`
    : `Enter runs ${line} for ${bot} · /${command.name} @branch aims at a worker`;
  return { text, isError: false };
}

/** Resolves to the sandbox's account of what the command did. */
export async function runCommand(sandbox, command) {
  if (command.error) throw new Error(command.error);
  return sendCommand(sandbox, { name: command.name, worker: command.worker?.name ?? null, argument: command.argument });
}
