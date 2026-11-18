import { main, runOperation } from '../session/main.mjs';
import { install, remove } from './launch-agent.mjs';
import { check, serve } from './launch-host.mjs';
import { configure, setEnabled, storeToken } from './launch-settings.mjs';
import { watch } from './launch-watch.mjs';

const USAGE = 'usage: mac/launch-gate configure ROOT_PRIVATE_MANIFEST | token | check | enable | disable | install | remove | serve | watch LAUNCH_ID';

function switchTo(isEnabled) {
  setEnabled(isEnabled);
  console.log(`Mac launch gate ${isEnabled ? 'enabled' : 'disabled'}.`);
}

main(import.meta, () => runOperation({
  configure: args => {
    if (args.length !== 1) throw new Error(USAGE);
    configure(args[0]);
    console.log('Protected settings saved. Launches remain disabled.');
  },
  token: storeToken, check, enable: async () => { await check(); switchTo(true); }, disable: () => switchTo(false), install, remove, serve, watch,
}, USAGE));
