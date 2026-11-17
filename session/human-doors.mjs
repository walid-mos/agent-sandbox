import { all, find, RESENDABLE } from './door-requests.mjs';
import { checkSent, prepareHumanAsk, prepareReply, transmit } from './doors.mjs';
import { acknowledgementOf } from './human-door-packets.mjs';

export const DOOR_RETRY_MS = 30_000;

function reply(id, text) {
  const pending = prepareReply(id, text);
  if (RESENDABLE.includes(pending?.state)) checkSent(transmit(pending));
}

export const dialogDoors = {
  find, all, transmit, reply,
  prepare: prepareHumanAsk,
  acknowledge: request => reply(request.id, acknowledgementOf(request.need)),
};
