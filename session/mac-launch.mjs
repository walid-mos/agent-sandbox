import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DOOR_COMMAND } from './door-command.mjs';
import { find as findDoorRequest, OPEN as WAITING, RECEIVED } from './door-requests.mjs';
import { ownName } from './doors.mjs';
import { isSnowflake, MASTERMIND_POT, text } from './human-contract.mjs';
import { launchNotice, noticeOf, noticeText, OPEN } from './launch-contract.mjs';
import { askClosure, launchStore, listedLaunches, openLaunch, recordStatus, shownLaunch, wakeBot } from './launch-requests.mjs';
import { main, runOperation } from './main.mjs';
import { command, commandWithInput } from './run.mjs';
import { botId, isMastermind, sandbox } from './sandbox.mjs';

const USAGE = 'usage: mac-launch.mjs request --target MAC --title TITLE [--acts ACT,ACT] [--cost TEXT] [--replaces LAUNCH_ID] PROMPT_FILE | cancel LAUNCH_ID | list | announce REQUEST_ID | show LAUNCH_ID | status';
const POST_MS = 10_000;
const REQUEST_OPTIONS = { target: { type: 'string' }, title: { type: 'string' }, acts: { type: 'string' }, cost: { type: 'string' }, replaces: { type: 'string' } };
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const asked = (launch, state) => ({ launch, asked: state, effective: false,
  next: `The Mac decides. It reports ${state} once it has closed this launch, or started with tooLate set if the operator's press came first.` });

function postNotice(content) {
  const { channelAccount, channelId } = sandbox.macLaunch ?? {};
  if (!text(channelAccount) || !isSnowflake(channelId)) throw new Error('mac-launch: Mastermind\'s macLaunch names no channelAccount and channelId to post notices in.');
  return commandWithInput('pots', ['call', '--bot', botId, channelAccount, `POST /channels/${channelId}/messages`, '-'], JSON.stringify({ content, allowed_mentions: { parse: [] } }), { timeout: POST_MS });
}

async function sendNotice(request) {
  const need = noticeText(launchNotice(request));
  if (isMastermind) return postNotice(need);
  return command(DOOR_COMMAND, ['ask', MASTERMIND_POT, '--need', need]);
}

async function askAndTell(id, state, store) {
  await sendNotice(await askClosure(id, state, store));
  print(asked(id, state));
}

function requestOptions(arguments_) {
  const { values, positionals: [file] } = parseArgs({ args: arguments_, options: REQUEST_OPTIONS, allowPositionals: true });
  if (!values.target || !values.title || !file) throw new Error(USAGE);
  return { values, file };
}

function requireReplaceableLaunch(values, store) {
  if (values.replaces && shownLaunch(values.replaces, store).state !== OPEN) {
    throw new Error(`mac-launch: launch ${values.replaces} is no longer open, so a new launch cannot replace it.`);
  }
}

function launchDraft(values, file) {
  return { target: values.target, title: values.title, acts: values.acts ? values.acts.split(',') : [], cost: values.cost ?? '', prompt: readFileSync(file, 'utf8') };
}

async function publishRequest(opened, values, store) {
  try {
    if (values.replaces) await askAndTell(values.replaces, 'superseded', store);
    await sendNotice(opened);
  } catch (error) {
    await store.locked(({ get, save }) => save({ ...get(opened.launch), state: 'failed' }), opened.launch);
    throw error;
  }
}

async function request(arguments_) {
  const { values, file } = requestOptions(arguments_);
  const store = launchStore();
  requireReplaceableLaunch(values, store);
  const opened = await openLaunch(launchDraft(values, file), { store, settings: sandbox.macLaunch, pot: ownName() });
  await publishRequest(opened, values, store);
  print(opened);
}

async function cancel([id]) {
  await askAndTell(id, 'cancelled', launchStore());
}

function requireMastermind() {
  if (!isMastermind) throw new Error('mac-launch: only Mastermind announces a launch notice.');
}

function waitingRequest(id) {
  const received = findDoorRequest(id);
  if (received?.direction !== RECEIVED || received.state !== WAITING || received.kind !== undefined) {
    throw new Error('mac-launch: no ordinary request with this ID waits for a reply here.');
  }
  return received;
}

function requireOwnLaunch(received) {
  if (noticeOf(received.need).pot !== received.pot) throw new Error('mac-launch: a pot announces only its own launches.');
}

async function announce([id]) {
  requireMastermind();
  const received = waitingRequest(id);
  requireOwnLaunch(received);
  await postNotice(received.need);
  command(DOOR_COMMAND, ['reply', id, '--text', 'Posted the launch notice in the launch channel. The Mac reports each next step to you itself.']);
}

async function status() {
  const report = await recordStatus(JSON.parse(readFileSync(0, 'utf8')), launchStore());
  wakeBot(report, botId);
  print({ stored: report.status });
}

const OPERATIONS = { request, cancel, announce, status, show: ([id]) => print(shownLaunch(id, launchStore())), list: () => print(listedLaunches(launchStore())) };

main(import.meta, () => runOperation(OPERATIONS, USAGE));
