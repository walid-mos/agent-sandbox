import { execFile } from 'node:child_process';
import { isPotName } from '../session/door-messages.mjs';
import { LAUNCH_SCRIPT } from '../session/launch-contract.mjs';

const REMOTE_TIMEOUT_SECONDS = 10;
const OUTPUT_BYTES = 128 * 1024;

export function potTransport() {
  async function call(pot, arguments_, input) {
    if (!isPotName(pot)) throw new Error('mac-launch: invalid pot name.');
    const options = ['exec', '--json', '--on', pot, '--timeout', `${REMOTE_TIMEOUT_SECONDS}`, ...(input === undefined ? [] : ['-i']), 'node', LAUNCH_SCRIPT, ...arguments_];
    const { stdout } = await runWithInput(options, input);
    const response = JSON.parse(stdout);
    if (response.code !== 0 || response.timed_out || response.truncated) throw new Error(`mac-launch: ${pot} did not complete the launch command.`);
    return JSON.parse(Buffer.from(response.stdout, 'base64').toString('utf8'));
  }
  return { show: (pot, id) => call(pot, ['show', id]), report: (pot, status) => call(pot, ['status'], JSON.stringify(status)) };
}

function runWithInput(arguments_, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('hc', arguments_, { encoding: 'utf8', maxBuffer: OUTPUT_BYTES, timeout: REMOTE_TIMEOUT_SECONDS * 1000 }, (error, stdout) => {
      if (error) return reject(new Error('mac-launch: Herdr could not reach the pot.'));
      resolve({ stdout });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
