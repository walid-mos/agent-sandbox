import { parseArgs } from 'node:util';
import { DOOR_COMMAND } from './door-command.mjs';
import { knock } from './door-knock.mjs';
import { DIALOG, dialogMessage, HOP_LIMIT, isPotName, MESSAGE_BYTES, newRequestId, Refusal, replyMessage, requestMessage } from './door-messages.mjs';
import { all, ANSWERED, ASKED, find, OPEN, RECEIVED, REFUSED, RESENDABLE, save, UNDELIVERED, underLock, UNKNOWN } from './door-requests.mjs';
import { receiveMessage } from './door-deliveries.mjs';
import { humanPacket } from './human-door-packets.mjs';
import { main, runOperation } from './main.mjs';
import { command } from './run.mjs';
import { sandbox } from './sandbox.mjs';

const CONNECTED = 'Running';
const SETTLED = [ANSWERED, REFUSED];
const DELIVERED_STATE = { [ASKED]: OPEN, [RECEIVED]: ANSWERED };
const USAGE = `usage: ${DOOR_COMMAND} ask POT --need TEXT [--for REQUEST_ID] | ${DOOR_COMMAND} reply REQUEST_ID --text TEXT | ${DOOR_COMMAND} resend REQUEST_ID | ${DOOR_COMMAND} requests [--all]`;

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

// Whatever this pot asks may serve any request it has not answered, so it goes one hop past the deepest of them, --for or not.
function chainHop() {
  const open = all().filter(request => request.direction === RECEIVED && request.state === OPEN && request.kind !== DIALOG);
  const hop = Math.max(-1, ...open.map(request => request.hop)) + 1;
  if (hop <= HOP_LIMIT) return hop;
  const deepest = open.filter(request => request.hop + 1 === hop).map(request => `${request.id} from ${request.pot}`).join(', ');
  throw new Error(`pots: this pot has not answered ${deepest}, which already came through ${hop} doors, the most a chain of requests takes, so it asks no pot anything until then. Reply with what this pot can do, then ask.`);
}

function servedRequest(servedId) {
  const served = find(servedId);
  if (served?.direction !== RECEIVED || served.state !== OPEN) throw new Error(`pots: --for names a request this pot received and has not answered, and ${servedId} is none. ${DOOR_COMMAND} requests lists them.`);
  return servedId;
}

// A knock's result changes a request only while it still waits on a knock, so a reply that came back meanwhile stays.
function settle(id, outcome) {
  const current = find(id);
  if (!RESENDABLE.includes(current.state)) return current;
  const settled = outcome ? { ...current, ...outcome } : { ...current, state: DELIVERED_STATE[current.direction], failure: undefined };
  save(settled);
  return settled;
}

function knockAndSettle(request, wire) {
  const outcome = knock(request.pot, wire);
  return underLock(() => settle(request.id, outcome));
}

// The message is saved before its door opens, so a cut line leaves it to resend under its own ID, never to ask twice.
function send(request, wire, done) {
  const { state, failure } = knockAndSettle(request, wire);
  if (state === UNKNOWN) throw new Error(`pots: ${request.id} may have reached ${request.pot}: ${failure}. ${DOOR_COMMAND} resend ${request.id} sends the same message, and ${request.pot} takes it once.`);
  if (state === UNDELIVERED) throw new Error(`pots: ${request.id} did not reach ${request.pot}: ${failure}. ${DOOR_COMMAND} resend ${request.id} sends it once the cause is gone.`);
  if (state === REFUSED) throw new Error(`pots: ${request.pot} refused ${request.id}: ${failure}. It is closed, and ${DOOR_COMMAND} resend refuses it. Tell the person; ${DOOR_COMMAND} requests lists what this pot still waits on from ${request.pot}.`);
  process.stdout.write(`${done} ${request.id}\n`);
}

export const prepareAsk = options => prepare(options);

export function prepareHumanAsk(options) {
  const packet = humanPacket(options.need);
  const isPosted = packet.type === 'human.posted';
  if (isPosted ? sandbox.role !== 'mastermind' || options.pot === 'mastermind' : sandbox.role === 'mastermind' || options.pot !== 'mastermind') throw new Error('pots: human dialog packet has the wrong direction.');
  return prepare(options, DIALOG);
}

const askWire = request => request.kind === DIALOG ? dialogMessage(request.id, request.need) : requestMessage(request.id, request.hop, request.need);

function prepare({ pot, need, served, key }, kind) {
  return underLock(() => {
    const existing = key && all().find(request => request.direction === ASKED && request.key === key && request.kind === kind);
    if (existing) return existing;
    const hop = kind === DIALOG ? undefined : chainHop();
    const target = neighbour(pot);
    const parent = served === undefined ? undefined : servedRequest(served);
    const id = newRequestId(ownName());
    const request = { id, direction: ASKED, pot: target, need, hop, for: parent, key, kind, state: UNKNOWN, at: Date.now() };
    askWire(request);
    save(request);
    return request;
  });
}

export function transmitAsk(request) {
  const current = find(request.id);
  if (!RESENDABLE.includes(current.state)) return current;
  return knockAndSettle(current, askWire(current));
}

function ask(arguments_) {
  const options = { need: { type: 'string' }, for: { type: 'string' } };
  const { values, positionals: [pot] } = parseArgs({ args: arguments_, options, allowPositionals: true });
  if (!pot || values.need === undefined) throw new Error(USAGE);
  const request = prepareAsk({ pot, need: values.need, served: values.for });
  send(request, requestMessage(request.id, request.hop, request.need), 'asked');
}

function recordReply(id, text) {
  const received = find(id);
  if (received?.direction !== RECEIVED) throw new Error(`pots: no request ${id} came through this pot's door. ${DOOR_COMMAND} requests lists the ones that did.`);
  const pending = RESENDABLE.includes(received.state) ? ` It has not reached ${received.pot} yet: ${DOOR_COMMAND} resend ${id} sends it again.` : '';
  if (received.state !== OPEN) throw new Error(`pots: ${id} already has its reply, and a request takes one.${pending}`);
  const replying = { ...received, state: UNKNOWN, reply: text, answeredAt: Date.now() };
  save(replying);
  return replying;
}

function reply(arguments_) {
  const { values, positionals: [id] } = parseArgs({ args: arguments_, options: { text: { type: 'string' } }, allowPositionals: true });
  if (!id || values.text === undefined) throw new Error(USAGE);
  const wire = replyMessage(id, values.text);
  send(underLock(() => recordReply(id, values.text)), wire, 'replied');
}

function recordResend(id) {
  const kept = find(id);
  if (!RESENDABLE.includes(kept?.state)) throw new Error(`pots: ${id} has nothing to resend: ${kept ? `it is ${kept.state}` : 'this pot holds no such request'}. ${DOOR_COMMAND} requests lists what waits.`);
  const resending = { ...kept, state: UNKNOWN };
  save(resending);
  return resending;
}

function resend([id, ...extra]) {
  if (!id || extra.length > 0) throw new Error(USAGE);
  const request = underLock(() => recordResend(id));
  const wire = request.direction === ASKED ? askWire(request) : replyMessage(id, request.reply);
  send(request, wire, 'resent');
}

function requests(arguments_) {
  const { values } = parseArgs({ args: arguments_, options: { all: { type: 'boolean' } } });
  const shown = all().filter(request => values.all || !SETTLED.includes(request.state));
  process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
}

async function standardInput(limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Refusal(`pots: the door handed over more than ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function deliver([caller]) {
  receiveMessage(caller, await standardInput(MESSAGE_BYTES));
}

main(import.meta, () => runOperation({ ask, reply, resend, requests, deliver }, USAGE));
