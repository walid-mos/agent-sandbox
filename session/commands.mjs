import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { command, failureReason } from './run.mjs';
import { botHome, sandbox } from './sandbox.mjs';
import { groupModel, ROUTER_MODEL } from './models.mjs';
import { liveTerminals, terminalOf } from './workers.mjs';

const AGENT = join(homedir(), '.pi/agent');
const BOT = join(botHome, 'bot.json');
const RELEASE = 'auto';
const INDENT = 2;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// Pi's /model switches at once only to one of these; any other opens its picker in the worker's terminal, out of the person's sight.
const models = () => readJson(join(AGENT, 'settings.json')).enabledModels ?? [];
const groups = () => [...readJson(join(AGENT, 'magpie-routing.json')).members, RELEASE];

export const botModel = () => readJson(BOT).model;

// pots applies an edit of bot.json within seconds, and keeps the definition before it while the edit has an error.
function setBotModel(model) {
  const bot = readJson(BOT);
  if (bot.model === model) return `${sandbox.bot} already runs on ${model}.`;
  writeFileSync(BOT, `${JSON.stringify({ ...bot, model }, null, INDENT)}\n`);
  return `${sandbox.bot} switches from ${bot.model} to ${model} within seconds.`;
}

// The bot has no Pi session to pin a group in, so a pin is its model and the release puts it back on the router.
const COMMANDS = {
  model: { choices: models, onBot: setBotModel },
  route: { choices: groups, onBot: group => setBotModel(group === RELEASE ? ROUTER_MODEL : groupModel(group)) },
};

/** The choice typed in full, or the only one it ends: `max` and `group/max` both name `magpie/group/max`. */
function chosen(choices, typed) {
  if (choices.includes(typed)) return typed;
  const matches = choices.filter(choice => choice.endsWith(`/${typed}`));
  if (matches.length === 1) return matches[0];
  throw new Error(`pots: ${typed} is not one of ${choices.join(', ')}.`);
}

// hc signs text sent from inside one of its terminals with that terminal's name, and Pi then reads it as a prompt.
function typeInto(worker, line) {
  const terminal = terminalOf(worker, liveTerminals());
  if (!terminal) throw new Error(`pots: the worker on ${worker.branch} is not running. Ask ${sandbox.bot} to bring it back, then run the command again.`);
  const { HC_TERMINAL_ID: _sender, ...environment } = process.env;
  try {
    command('hc', ['send', '--', terminal.address, line], { env: environment });
  } catch (error) {
    const reason = failureReason(error) || 'hc did not answer.';
    throw new Error(`pots: ${line} did not reach the worker on ${worker.branch}. ${reason}`, { cause: error });
  }
  return `Sent ${line} to the worker on ${worker.branch}.`;
}

function listing(name, choices, worker) {
  const current = worker ? '' : `${sandbox.bot} runs on ${botModel()}. `;
  return `${current}/${name} takes ${choices.join(', ')}.`;
}

/** Runs /model or /route on the bot, or types it into a worker's Pi. With no argument it says what the command takes. */
export function runCommand({ name, worker, argument }) {
  if (!Object.hasOwn(COMMANDS, name)) throw new Error(`pots: no /${name} here. Use /model or /route.`);
  const { choices, onBot } = COMMANDS[name];
  const typed = `${argument}`.trim();
  if (!typed) return listing(name, choices(), worker);
  const choice = chosen(choices(), typed);
  return worker ? typeInto(worker, `/${name} ${choice}`) : onBot(choice);
}
