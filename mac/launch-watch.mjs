import { execFileSync } from 'node:child_process';
import { commandOutput } from '../session/run.mjs';
import { gateStore } from './launch-store.mjs';
import { loadSettings, STATE_HOME } from './launch-settings.mjs';
import { protectedHerdr } from './launch-runner.mjs';

export async function watch(arguments_) {
  const [id, ...extra] = arguments_;
  if (extra.length) throw new Error('mac-launch: watch accepts one launch ID.');
  const context = protectedHerdr(loadSettings());
  const run = gateStore(STATE_HOME).get(id)?.run;
  if (!run) throw new Error('mac-launch: no tracked run exists for this launch.');
  const terminal = JSON.parse(await commandOutput(context.binary, ['get', '--json', run.name], { env: context.env, timeout: 5000 }));
  if (terminal.created_ms !== run.createdMs || terminal.labels?.['mac-launch.id'] !== id) throw new Error('mac-launch: Herdr terminal identity changed. Refusing attachment.');
  execFileSync(context.binary, ['attach', run.name], { env: context.env, stdio: 'inherit' });
}
