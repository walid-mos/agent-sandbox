import { randomBytes } from 'node:crypto';

const POT = '[a-z][a-z0-9-]{0,30}';
const NONCE = '[a-z0-9]{8,32}';
const POT_NAME = new RegExp(`^${POT}$`);
const REQUEST_ID = new RegExp(`^(${POT})\\.${NONCE}$`);
const HEADER = new RegExp(`^(request|reply) (${POT}\\.${NONCE})$`);
const NONCE_BYTES = 8;
const NUL = '\0';
const LINE_BREAK = '\n';
const strictText = new TextDecoder('utf-8', { fatal: true });
// The door of the receiving pot's VM refuses a longer message, header included.
export const MESSAGE_BYTES = 16384;
export const REQUEST = 'request';
export const REPLY = 'reply';

export const isPotName = name => POT_NAME.test(name ?? '');
export const isRequestId = id => REQUEST_ID.test(id ?? '');
export const originOf = id => REQUEST_ID.exec(id)[1];
export const newRequestId = origin => `${origin}.${randomBytes(NONCE_BYTES).toString('hex')}`;

export function message(kind, id, text) {
  if (!`${text ?? ''}`.trim()) throw new Error('pots: the text is empty. Say what you need or what you answer.');
  if (text.includes(NUL)) throw new Error('pots: the text holds a NUL byte, which a door refuses. Remove it.');
  const wire = `${kind} ${id}${LINE_BREAK}${text}`;
  const size = Buffer.byteLength(wire);
  if (size > MESSAGE_BYTES) throw new Error(`pots: the message is ${size} bytes and a door takes ${MESSAGE_BYTES}. Shorten the text, or point to a pull request.`);
  return wire;
}

function decoded(bytes) {
  try {
    return strictText.decode(bytes);
  } catch {
    throw new Error('pots: the door handed over bytes that are not UTF-8 text.');
  }
}

// The door checks its message in the VM, out of this session's sight, so the session checks what it is handed again.
export function parse(bytes) {
  if (bytes.length > MESSAGE_BYTES) throw new Error(`pots: the door handed over more than ${MESSAGE_BYTES} bytes.`);
  const wire = decoded(bytes);
  const headerEnd = wire.indexOf(LINE_BREAK);
  const header = HEADER.exec(headerEnd < 0 ? wire : wire.slice(0, headerEnd));
  if (!header) throw new Error('pots: the first line is not "request ORIGIN.NONCE" or "reply ORIGIN.NONCE".');
  const text = headerEnd < 0 ? '' : wire.slice(headerEnd + 1);
  if (!text.trim() || text.includes(NUL)) throw new Error('pots: the note is empty or holds a NUL byte.');
  const [, kind, id] = header;
  return { kind, id, origin: originOf(id), text };
}
