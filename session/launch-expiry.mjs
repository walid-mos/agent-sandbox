import { expireLaunches, launchStore } from './launch-requests.mjs';
import { launchStatus } from './launch-contract.mjs';
import { main } from './main.mjs';
import { command } from './run.mjs';
import { botId, sandbox } from './sandbox.mjs';

const PASS_MS = 5000;

main(import.meta, () => {
  if (sandbox.macLaunch?.enabled !== true) return;
  const store = launchStore();
  const notify = async request => {
    const status = launchStatus({ ...request, status: 'expired' });
    command('pots', ['wake', '--bot', botId, '--from', 'mac-launch', '--id', `mac-launch-${request.launch}-expired`, '--note', JSON.stringify(status)]);
  };
  async function pass() {
    try { await expireLaunches(store, notify); }
    catch { process.stderr.write('mac-launch: expiry reporting failed and will retry.\n'); }
    setTimeout(pass, PASS_MS);
  }
  return pass();
});
