import { main, runOperation } from '../session/main.mjs';
import { disable, install, remove } from './launch-agent.mjs';
import { check, serve } from './launch-host.mjs';
import { configure, storeToken } from './launch-settings.mjs';
import { watch } from './launch-watch.mjs';

const USAGE = 'usage: mac/launch-gate configure ROOT_PRIVATE_MANIFEST | token | check | disable | install | remove | serve | watch LAUNCH_ID';

main(import.meta, () => runOperation({
  configure: args => {
    if (args.length !== 1) throw new Error(USAGE);
    configure(args[0]);
    console.log('Protected settings saved.');
  },
  token: storeToken, check, disable, install, remove, serve, watch,
}, USAGE));
