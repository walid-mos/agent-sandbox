import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { main, runOperation } from '../session/main.mjs';
import { check, serve } from './launch-host.mjs';
import { configure, KEYCHAIN_SERVICE, loadSettings, SETTINGS } from './launch-settings.mjs';
import { writePrivate } from './launch-store.mjs';

const OPTIONS = Object.fromEntries(['name', 'label', 'operator', 'guild', 'channel', 'announcer', 'pots', 'directory'].map(name => [name, { type: 'string' }]));
const USAGE = 'usage: mac/launch-gate configure --name NAME --label LABEL --operator ID --guild ID --channel ID --announcer ID --pots POT,POT [--directory PATH] | token | check | enable | disable | serve';

function switchTo(state) {
  const isEnabled = state === 'enabled';
  const settings = loadSettings();
  writePrivate(SETTINGS, { ...settings, humanDiscord: { ...settings.humanDiscord, macLaunchEnabled: isEnabled } });
  console.log(`Mac launch gate ${isEnabled ? 'enabled' : 'disabled'}.`);
}

function token() {
  if (process.platform !== 'darwin' || !process.stdin.isTTY) throw new Error('mac-launch: run token yourself in a terminal on the Mac.');
  execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-a', userInfo().username, '-s', KEYCHAIN_SERVICE, '-w'], { stdio: 'inherit' });
}

main(import.meta, () => runOperation({
  configure: args => { configure(parseArgs({ args, options: OPTIONS }).values); console.log('Private settings saved. Launches remain disabled.'); },
  token, check, enable: async () => { await check(); switchTo('enabled'); }, disable: () => switchTo('disabled'), serve,
}, USAGE));
