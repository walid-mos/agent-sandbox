import { fileURLToPath } from 'node:url';
import { OPEN, RESENDABLE } from './door-requests.mjs';
import { commandOutput } from './run.mjs';

const DOORS = fileURLToPath(new URL('./doors.mjs', import.meta.url));
export const DOOR_RETRY_MS = 30_000;

export async function replyReceived(request, text) {
  if (request.state === OPEN) await commandOutput('node', [DOORS, 'reply', request.id, '--text', text]);
  else if (RESENDABLE.includes(request.state)) await commandOutput('node', [DOORS, 'resend', request.id]);
}
