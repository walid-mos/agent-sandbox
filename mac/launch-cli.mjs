import { parseArgs } from 'node:util';
import { main, runOperation } from '../session/main.mjs';
import { install, remove } from './launch-agent.mjs';
import { check, serve } from './launch-host.mjs';
import { configure, setEnabled, storeToken } from './launch-settings.mjs';

const OPTIONS = Object.fromEntries(['name', 'label', 'operator', 'guild', 'channel', 'announcer', 'pots', 'directory'].map(name => [name, { type: 'string' }]));
const USAGE = 'usage: mac/launch-gate configure --name NAME --label LABEL --operator ID --guild ID --channel ID --announcer ID --pots POT,POT [--directory PATH] | token | check | enable | disable | install | remove | serve';

function switchTo(isEnabled) {
  setEnabled(isEnabled);
  console.log(`Mac launch gate ${isEnabled ? 'enabled' : 'disabled'}.`);
}

main(import.meta, () => runOperation({
  configure: args => { configure(parseArgs({ args, options: OPTIONS }).values); console.log('Private settings saved. Launches remain disabled.'); },
  token: storeToken, check, enable: async () => { await check(); switchTo(true); }, disable: () => switchTo(false), install, remove, serve,
}, USAGE));
