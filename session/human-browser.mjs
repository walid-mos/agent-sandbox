import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { dialogSource, VERSION } from './human-contract.mjs';

const HANDOFF_MS = 10_000;
const REQUEST_LIMIT = 65_536;
const REPLY_LIMIT = 4096;
const PERMISSION_BITS = 0o7777;
const PARKED_FIELDS = JSON.stringify(['dialog', 'handoff', 'origin', 'source', 'version']);
const NO_SOCKET = 'human: the waiting tool has no private browser socket. Open a new call.';
const UNCONFIRMED = 'human: the waiting tool did not confirm the browser handoff. Open a new call.';

function isOwnSocket(path) {
  try {
    const folder = lstatSync(dirname(path));
    const socket = lstatSync(path);
    const uid = process.getuid();
    return folder.isDirectory() && folder.uid === uid && (folder.mode & PERMISSION_BITS) === 0o700
      && socket.isSocket() && socket.uid === uid && (socket.mode & PERMISSION_BITS) === 0o600;
  } catch {
    return false;
  }
}

function parkedReceipt(line, dialog) {
  try {
    const reply = JSON.parse(line);
    if (JSON.stringify(Object.keys(reply).sort()) !== PARKED_FIELDS || reply.version !== VERSION || reply.dialog !== dialog.id
      || reply.origin !== dialog.target.origin || !/^[a-f0-9]{32}$/.test(reply.handoff)
      || JSON.stringify(reply.source) !== JSON.stringify(dialogSource(dialog.source))) return undefined;
    return { target: { destination: 'browser', origin: reply.origin }, handoff: reply.handoff };
  } catch {
    return undefined;
  }
}

function exchange(dialog, frame) {
  return new Promise((resolve, reject) => {
    const connection = createConnection({ path: dialog.target.socket });
    let reply = Buffer.alloc(0);
    let isSettled = false;
    const finish = receipt => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(deadline);
      connection.destroy();
      if (receipt) resolve(receipt);
      else reject(new Error(UNCONFIRMED));
    };
    const deadline = setTimeout(() => finish(), Math.min(HANDOFF_MS, dialog.expiresAt - Date.now()));
    connection.on('error', () => finish());
    connection.on('close', () => finish());
    connection.on('connect', () => connection.write(frame));
    connection.on('data', chunk => {
      if (reply.length + chunk.length > REPLY_LIMIT) return finish();
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf('\n');
      if (end < 0) return;
      if (end !== reply.length - 1) return finish();
      return finish(parkedReceipt(reply.subarray(0, end).toString('utf8'), dialog));
    });
  });
}

export async function handOffBrowserSecret(dialog, value) {
  if (!isOwnSocket(dialog.target.socket)) throw new Error(NO_SOCKET);
  const { origin, capability } = dialog.target;
  const frame = `${JSON.stringify({ version: VERSION, dialog: dialog.id, source: dialog.source, origin, capability, value })}\n`;
  if (Buffer.byteLength(frame) > REQUEST_LIMIT || dialog.expiresAt <= Date.now()) throw new Error(UNCONFIRMED);
  return exchange(dialog, frame);
}
