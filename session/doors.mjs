import { parseArgs } from 'node:util';
import { knock } from './door-knock.mjs';
import { isPotName, MESSAGE_BYTES, message, newRequestId, parse, REPLY, REQUEST } from './door-messages.mjs';
import { all, ANSWERED, ASKED, find, OPEN, RECEIVED, remove, save, UNDELIVERED, underLock, UNKNOWN } from './door-requests.mjs';
import { main, runOperation } from './main.mjs';
import { command, failureReason } from './run.mjs';
import { botId, sandbox } from './sandbox.mjs';

const CONNECTED = 'Running';
// A pot that answers nothing cannot be made to hold an endless list: its neighbour waits for an answer first.
const UNANSWERED_REQUESTS_PER_POT = 20;
const RESENDABLE = [UNKNOWN, UNDELIVERED];
const DELIVERED_STATE = { [ASKED]: OPEN, [RECEIVED]: ANSWERED };
const USAGE = 'usage: pots ask POT --need TEXT | pots reply REQUEST_ID --text TEXT | pots resend REQUEST_ID | pots requests [--all]';

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

// A knock's result changes a request only while it still waits on a knock, so a reply that came back meanwhile stays.
function settle(id, outcome) {
  const current = find(id);
  if (!RESENDABLE.includes(current.state)) return current;
  const settled = outcome ? { ...current, ...outcome } : { ...current, state: DELIVERED_STATE[current.direction], failure: undefined };
  save(settled);
  return settled;
}

// The message is saved before its door opens, so a cut line leaves it to resend under its own ID, never to ask twice.
function send(request, wire, done) {
  const outcome = knock(request.pot, wire);
  const { state, failure } = underLock(() => settle(request.id, outcome));
  if (state === UNKNOWN) throw new Error(`pots: ${request.id} may have reached ${request.pot}: ${failure}. pots resend ${request.id} sends the same message, and ${request.pot} takes it once.`);
  if (state === UNDELIVERED) throw new Error(`pots: ${request.id} did not reach ${request.pot}: ${failure}. pots resend ${request.id} sends it once the cause is gone.`);
  process.stdout.write(`${done} ${request.id}\n`);
}

function ask(arguments_) {
  const { values, positionals: [pot] } = parseArgs({ args: arguments_, options: { need: { type: 'string' } }, allowPositionals: true });
  if (!pot || values.need === undefined) throw new Error(USAGE);
  const target = neighbour(pot);
  const id = newRequestId(ownName());
  const wire = message(REQUEST, id, values.need);
  const request = { id, direction: ASKED, pot: target, need: values.need, state: UNKNOWN, at: Date.now() };
  underLock(() => save(request));
  send(request, wire, 'asked');
}

function recordReply(id, text) {
  const received = find(id);
  if (received?.direction !== RECEIVED) throw new Error(`pots: no request ${id} came through this pot's door. pots requests lists the ones that did.`);
  const pending = RESENDABLE.includes(received.state) ? ` It has not reached ${received.pot} yet: pots resend ${id} sends it again.` : '';
  if (received.state !== OPEN) throw new Error(`pots: ${id} already has its reply, and a request takes one.${pending}`);
  const replying = { ...received, state: UNKNOWN, reply: text, answeredAt: Date.now() };
  save(replying);
  return replying;
}

function reply(arguments_) {
  const { values, positionals: [id] } = parseArgs({ args: arguments_, options: { text: { type: 'string' } }, allowPositionals: true });
  if (!id || values.text === undefined) throw new Error(USAGE);
  const wire = message(REPLY, id, values.text);
  send(underLock(() => recordReply(id, values.text)), wire, 'replied');
}

function recordResend(id) {
  const kept = find(id);
  if (!RESENDABLE.includes(kept?.state)) throw new Error(`pots: ${id} has nothing to resend: ${kept ? `it is ${kept.state}` : 'this pot holds no such request'}. pots requests lists what waits.`);
  const resending = { ...kept, state: UNKNOWN };
  save(resending);
  return resending;
}

function resend([id, ...extra]) {
  if (!id || extra.length > 0) throw new Error(USAGE);
  const request = underLock(() => recordResend(id));
  const wire = request.direction === ASKED ? message(REQUEST, id, request.need) : message(REPLY, id, request.reply);
  send(request, wire, 'resent');
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

// Each returns the record to keep, or nothing when the door already delivered this very message and a resend brings it again.
const ACCEPTED = {
  [REQUEST]({ caller, id, origin, text }) {
    if (origin !== caller) throw new Error(`pots: request ${id} is in the name of ${origin}, and ${caller} sent it.`);
    const known = find(id);
    if (known?.direction === RECEIVED && known.need === text) return undefined;
    if (known) throw new Error(`pots: ${id} already names another message.`);
    const unanswered = all().filter(request => request.direction === RECEIVED && request.pot === caller && request.state !== ANSWERED);
    if (unanswered.length >= UNANSWERED_REQUESTS_PER_POT) throw new Error(`pots: ${caller} has ${unanswered.length} requests here that wait for their reply.`);
    return { id, direction: RECEIVED, pot: caller, need: text, state: OPEN, at: Date.now() };
  },
  [REPLY]({ caller, id, text }) {
    const asked = find(id);
    if (asked?.direction !== ASKED || asked.pot !== caller) throw new Error(`pots: this pot asked ${caller} nothing under ${id}.`);
    if (asked.state !== ANSWERED) return { ...asked, state: ANSWERED, reply: text, answeredAt: Date.now(), failure: undefined };
    if (asked.reply === text) return undefined;
    throw new Error(`pots: ${id} already has its reply, and a request takes one.`);
  },
};

// The note is JSON, so a neighbour's text is one string in it and never reads as a flag or as a second header.
function wake({ caller, kind, id, text }) {
  const note = JSON.stringify({ kind, id, pot: caller, text });
  command('pots', ['wake', '--bot', botId, '--from', `pot-${caller}`, '--id', `door-${kind}-${id.replace('.', '-')}`, '--note', note]);
}

function keep(delivery) {
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

async function deliver([caller]) {
  if (!isPotName(caller)) throw new Error(`pots: a door delivery comes from pot:NAME, and this one names ${caller}.`);
  const delivery = { caller, ...parse(await standardInput(MESSAGE_BYTES)) };
  // One delivery at a time: the duplicate check, the count, the save and the wake never interleave with another one.
  underLock(() => keep(delivery));
}

main(import.meta, () => runOperation({ ask, reply, resend, requests, deliver }, USAGE));
