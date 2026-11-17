import { isPotName } from '../session/door-messages.mjs';
import { LAUNCH_SCRIPT } from '../session/launch-contract.mjs';
import { commandWithInput } from '../session/run.mjs';

const REMOTE_TIMEOUT_SECONDS = 10;

export function potTransport() {
  async function exec(pot, command, input) {
    if (!isPotName(pot)) throw new Error('mac-launch: invalid pot name.');
    const options = ['exec', '--json', '--on', pot, '--timeout', `${REMOTE_TIMEOUT_SECONDS}`, ...(input === undefined ? [] : ['-i']), ...command];
    const stdout = await commandWithInput('hc', options, input, { timeout: REMOTE_TIMEOUT_SECONDS * 1000 })
      .catch(() => { throw new Error('mac-launch: Herdr could not reach the pot.'); });
    const response = JSON.parse(stdout);
    if (response.code !== 0 || response.timed_out || response.truncated) throw new Error(`mac-launch: ${pot} did not complete the command.`);
    return Buffer.from(response.stdout, 'base64').toString('utf8');
  }
  const call = async (pot, arguments_, input) => JSON.parse(await exec(pot, ['node', LAUNCH_SCRIPT, ...arguments_], input));
  return { show: (pot, id) => call(pot, ['show', id]), report: (pot, status) => call(pot, ['status'], JSON.stringify(status)), reach: pot => exec(pot, ['node', '--version']) };
}
