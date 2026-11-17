import { all, find, RESENDABLE } from './door-requests.mjs';
import { checkSent, prepareHumanAsk, prepareReply, transmit, transmitAsync } from './doors.mjs';
import { acknowledgementOf } from './human-door-packets.mjs';

export const DOOR_RETRY_MS = 30_000;

async function reply(id, text) {
  const pending = prepareReply(id, text);
  if (!pending) return undefined;
  const delivered = RESENDABLE.includes(pending.state) ? await transmitAsync(pending) : pending;
  checkSent(delivered);
  return delivered;
}

export const dialogDoors = {
  find, all, transmit, transmitAsync, reply,
  prepare: prepareHumanAsk,
  acknowledge: request => reply(request.id, acknowledgementOf(request.need)),
};
