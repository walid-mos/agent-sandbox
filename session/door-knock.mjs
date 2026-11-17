import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REFUSED_EXIT } from './door-messages.mjs';
import { REFUSED, UNDELIVERED, UNKNOWN } from './door-requests.mjs';

const DOOR_CONFIG = fileURLToPath(new URL('./door.ssh_config', import.meta.url));
// Outlasts the door's 5 s whois plus 45 s delivery (vm/pots-door.py), so a slow delivery ends with the door's own exit, not a timeout here.
const DOOR_SECONDS = 60;
const DELIVERED = 0;
// The door kept nothing on these exits. Any other end, a failed wake, a timeout or a cut line included, can come after the neighbour kept the message.
const NOT_KEPT = {
  64: 'the door refused the message as malformed',
  65: 'the message is over the door\'s size limit',
  69: 'the neighbour pot has no running session',
  75: 'the door takes no more messages from this pot for now',
  77: 'the door does not let this pot in',
};
const MAY_BE_KEPT = 'the door gave no clear answer, so the neighbour may hold the message already';
const REFUSED_BY_SESSION = 'the neighbour\'s session refused the message, kept nothing and would refuse it again';
const TIMEOUT = `no answer in ${DOOR_SECONDS} s`;

// Nothing a door or a neighbour prints comes back: the exit code alone decides, in words this pot chose.
function outcome(pot, ending, status) {
  if (status === REFUSED_EXIT) return { state: REFUSED, failure: `door of ${pot}, ${ending}: ${REFUSED_BY_SESSION}` };
  const reason = NOT_KEPT[status];
  return reason
    ? { state: UNDELIVERED, failure: `door of ${pot}, ${ending}: ${reason}` }
    : { state: UNKNOWN, failure: `door of ${pot}, ${ending}: ${MAY_BE_KEPT}` };
}

const DOOR = pot => ['-F', DOOR_CONFIG, '--', `${pot}-host`];

export function knock(pot, wire) {
  const { status, signal, error } = spawnSync('ssh', DOOR(pot), { input: wire, timeout: DOOR_SECONDS * 1000, stdio: ['pipe', 'ignore', 'ignore'] });
  if (status === DELIVERED) return undefined;
  return outcome(pot, error?.code === 'ETIMEDOUT' ? TIMEOUT : `exit ${status ?? signal ?? error?.code}`, status);
}

// The service that relays an answer keeps handling clicks meanwhile, so a slow door here must not hold its event loop.
export function knockAsync(pot, wire) {
  return new Promise(resolve => {
    const child = execFile('ssh', DOOR(pot), { timeout: DOOR_SECONDS * 1000, stdio: ['pipe', 'ignore', 'ignore'] }, error => {
      if (!error) return resolve(undefined);
      const expired = error.killed === true && `${error.signal}` === 'SIGTERM';
      resolve(outcome(pot, expired ? TIMEOUT : `exit ${error.code ?? error.signal ?? error.code}`, error.code));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(wire);
  });
}
