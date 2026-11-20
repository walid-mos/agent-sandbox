import { randomBytes } from 'node:crypto';

const POT = '[a-z][a-z0-9-]{0,30}';
const NONCE = '[a-z0-9]{8,32}';
const POT_NAME = new RegExp(`^${POT}$`);
const REQUEST_ID = new RegExp(`^(${POT})\\.${NONCE}$`);
const HEADER = new RegExp(`^(request|reply|dialog|board) (${POT}\\.${NONCE})(?: ([0-9]))?$`);
const NONCE_BYTES = 8;
const NUL = '\0';
const LINE_BREAK = '\n';
const strictText = new TextDecoder('utf-8', { fatal: true });
// The door of the receiving pot's VM refuses a longer message, header included.
export const MESSAGE_BYTES = 16384;
// The receiving pot's door passes this exit through as its own, so the caller knows the session kept nothing and would refuse the same message again.
export const REFUSED_EXIT = 76;
export const REQUEST = 'request';
export const REPLY = 'reply';
export const DIALOG = 'dialog';
export const BOARD = 'board';
// A pot asks one hop past the deepest request it has not answered, so pots asking each other in a loop stop at the third door.
export const HOP_LIMIT = 2;

export class Refusal extends Error {
  exitCode = REFUSED_EXIT;
}

export const isPotName = name => POT_NAME.test(name ?? '');
export const isRequestId = id => REQUEST_ID.test(id ?? '');
export const originOf = id => REQUEST_ID.exec(id)[1];
export const newRequestId = origin => `${origin}.${randomBytes(NONCE_BYTES).toString('hex')}`;

export const requestMessage = (id, hop, text) => message(`${REQUEST} ${id} ${hop}`, text);
export const replyMessage = (id, text) => message(`${REPLY} ${id}`, text);
export const dialogMessage = (id, text) => message(`${DIALOG} ${id}`, text);
export const boardMessage = (id, text) => message(`${BOARD} ${id}`, text);

function message(header, text) {
  if (!`${text ?? ''}`.trim()) throw new Error('pots: the text is empty. Say what you need or what you answer.');
  if (text.includes(NUL)) throw new Error('pots: the text holds a NUL byte, which a door refuses. Remove it.');
  const wire = `${header}${LINE_BREAK}${text}`;
  const size = Buffer.byteLength(wire);
  if (size > MESSAGE_BYTES) throw new Error(`pots: the message is ${size} bytes and a door takes ${MESSAGE_BYTES}. Shorten the text, or point to a pull request.`);
  return wire;
}

function decoded(bytes) {
  try {
    return strictText.decode(bytes);
  } catch {
    throw new Refusal('pots: the door handed over bytes that are not UTF-8 text.');
  }
}

// The door checks its message in the VM, out of this session's sight, so the session checks what it is handed again.
export function parse(bytes) {
  if (bytes.length > MESSAGE_BYTES) throw new Refusal(`pots: the door handed over more than ${MESSAGE_BYTES} bytes.`);
  const wire = decoded(bytes);
  const headerEnd = wire.indexOf(LINE_BREAK);
  const header = HEADER.exec(headerEnd < 0 ? wire : wire.slice(0, headerEnd));
  const [, kind, id, hop] = header ?? [];
  if (!header || (kind === REQUEST) !== (hop !== undefined)) throw new Refusal('pots: the first line is not "request ORIGIN.NONCE HOP" or "reply ORIGIN.NONCE" or "dialog ORIGIN.NONCE" or "board ORIGIN.NONCE".');
  const text = headerEnd < 0 ? '' : wire.slice(headerEnd + 1);
  if (!text.trim() || text.includes(NUL)) throw new Refusal('pots: the note is empty or holds a NUL byte.');
  return { kind, id, origin: originOf(id), hop: hop === undefined ? undefined : Number(hop), text };
}
