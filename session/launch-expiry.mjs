import { expireLaunches, launchStore, wakeBot } from './launch-requests.mjs';
import { main } from './main.mjs';
import { botId, sandbox } from './sandbox.mjs';

const PASS_MS = 5000;

main(import.meta, () => {
  if (sandbox.macLaunch?.enabled !== true) return;
  const store = launchStore();
  const notify = async report => wakeBot(report, botId);
  async function pass() {
    try { await expireLaunches(store, notify); }
    catch { process.stderr.write('mac-launch: expiry reporting failed and will retry.\n'); }
    setTimeout(pass, PASS_MS);
  }
  return pass();
});
