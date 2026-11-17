import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isPotName, MESSAGE_BYTES, message, newRequestId, parse, REPLY, REQUEST } from './door-messages.mjs';
import { all, ANSWERED, ASKED, find, OPEN, RECEIVED, remove, save, UNDELIVERED } from './door-requests.mjs';
import { main, runOperation } from './main.mjs';
import { command, failureReason } from './run.mjs';
import { botId, sandbox } from './sandbox.mjs';

const DOOR_CONFIG = fileURLToPath(new URL('./door.ssh_config', import.meta.url));
const DOOR_SECONDS = 60;
const CONNECTED = 'Running';
// A pot that answers nothing cannot be made to hold an endless list: its neighbour waits for an answer first.
const OPEN_REQUESTS_PER_POT = 20;
const USAGE = 'usage: pots ask POT --need TEXT | pots reply REQUEST_ID --text TEXT | pots requests [--all]';

const doors = () => sandbox.doors ?? {};

function neighbour(pot) {
  if (isPotName(pot) && Object.hasOwn(doors(), pot)) return pot;
  const known = Object.entries(doors()).map(([name, owns]) => `${name} (${owns})`).join(', ');
  throw new Error(`pots: this pot has no door to ${pot}. ${known ? `Use one of: ${known}.` : 'Its sandbox.json names none under doors.'}`);
}

// A door takes a request only under the name its key is bound to, which is the name of this pot's tailnet node.
function ownName() {
  try {
    const status = JSON.parse(command('tailscale', ['status', '--json', '--peers=false']));
    const [name] = `${status.Self?.DNSName ?? ''}`.split('.');
    if (status.BackendState === CONNECTED && isPotName(name)) return name;
  } catch (error) {
    throw new Error('pots: tailscale did not answer in this session, so this pot cannot ask. Check tailscale status, then ask again.', { cause: error });
  }
  throw new Error('pots: this pot\'s tailnet node is not connected, so it has no name to ask under. Check tailscale status, then ask again.');
}

// Nothing a pot's session prints comes back through its door: the exit code and the door's own line are the whole answer.
function knock(pot, wire) {
  const { status, stderr, error } = spawnSync('ssh', ['-F', DOOR_CONFIG, '--', `${pot}-host`], {
    input: wire, encoding: 'utf8', timeout: DOOR_SECONDS * 1000, stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (status === 0) return;
  const reason = `${stderr ?? ''}`.trim().split('\n').at(-1) || error?.message || 'no reason given';
  throw new Error(`pots: the door of ${pot} did not take it (exit ${status ?? 'none'}): ${reason}`);
}

function ask(arguments_) {
  const { values, positionals: [pot] } = parseArgs({ args: arguments_, options: { need: { type: 'string' } }, allowPositionals: true });
  if (!pot || values.need === undefined) throw new Error(USAGE);
  const target = neighbour(pot);
  const id = newRequestId(ownName());
  const wire = message(REQUEST, id, values.need);
  const request = { id, direction: ASKED, pot: target, need: values.need, state: OPEN, at: Date.now() };
  // The record is there before the door opens, so a reply that comes back at once finds it.
  save(request);
  try {
    knock(target, wire);
  } catch (error) {
    save({ ...request, state: UNDELIVERED, failure: error.message });
    throw error;
  }
  process.stdout.write(`asked ${id}\n`);
}

function reply(arguments_) {
  const { values, positionals: [id] } = parseArgs({ args: arguments_, options: { text: { type: 'string' } }, allowPositionals: true });
  if (!id || values.text === undefined) throw new Error(USAGE);
  const request = find(id);
  if (request?.direction !== RECEIVED) throw new Error(`pots: no request ${id} came through this pot's door. pots requests lists the ones that did.`);
  if (request.state !== OPEN) throw new Error(`pots: ${id} already has its reply, and a request takes one.`);
  knock(request.pot, message(REPLY, id, values.text));
  save({ ...request, state: ANSWERED, reply: values.text, answeredAt: Date.now() });
  process.stdout.write(`replied ${id}\n`);
}

function requests(arguments_) {
  const { values } = parseArgs({ args: arguments_, options: { all: { type: 'boolean' } } });
  const shown = all().filter(request => values.all || request.state !== ANSWERED);
  process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
}

async function standardInput(limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error(`pots: the door handed over more than ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Each returns the record to keep, or nothing when the door already delivered this very message and a retry brings it again.
const ACCEPTED = {
  [REQUEST]({ caller, id, origin, text }) {
    if (origin !== caller) throw new Error(`pots: request ${id} is in the name of ${origin}, and ${caller} sent it.`);
    const known = find(id);
    if (known?.direction === RECEIVED && known.need === text) return undefined;
    if (known) throw new Error(`pots: ${id} already names another message.`);
    const open = all().filter(request => request.direction === RECEIVED && request.pot === caller && request.state === OPEN);
    if (open.length >= OPEN_REQUESTS_PER_POT) throw new Error(`pots: ${caller} has ${open.length} requests open here already.`);
    return { id, direction: RECEIVED, pot: caller, need: text, state: OPEN, at: Date.now() };
  },
  [REPLY]({ caller, id, text }) {
    const asked = find(id);
    if (asked?.direction !== ASKED || asked.pot !== caller) throw new Error(`pots: this pot asked ${caller} nothing under ${id}.`);
    if (asked.state !== ANSWERED) return { ...asked, state: ANSWERED, reply: text, answeredAt: Date.now() };
    if (asked.reply === text) return undefined;
    throw new Error(`pots: ${id} already has its reply, and a request takes one.`);
  },
};

// The note is JSON, so a neighbour's text is one string in it and never reads as a flag or as a second header.
function wake({ caller, kind, id, text }) {
  const note = JSON.stringify({ kind, id, pot: caller, text });
  command('pots', ['wake', '--bot', botId, '--from', `pot-${caller}`, '--id', `door-${kind}-${id.replace('.', '-')}`, '--note', note]);
}

async function deliver([caller]) {
  if (!isPotName(caller)) throw new Error(`pots: a door delivery comes from pot:NAME, and this one names ${caller}.`);
  const delivery = { caller, ...parse(await standardInput(MESSAGE_BYTES)) };
  const record = ACCEPTED[delivery.kind](delivery);
  if (!record) return;
  const previous = find(record.id);
  save(record);
  try {
    wake(delivery);
  } catch (error) {
    if (previous) save(previous);
    else remove(record.id);
    throw new Error(`pots: ${sandbox.bot} could not be woken for ${record.id}, so it was not kept. ${failureReason(error) || error.code || ''}`, { cause: error });
  }
}

main(import.meta, () => runOperation({ ask, reply, requests, deliver }, USAGE));
