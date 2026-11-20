import { execFileSync } from 'node:child_process';
import { commandOutput } from '../session/run.mjs';
import { gateStore } from './launch-store.mjs';
import { loadSettings, STATE_HOME } from './launch-settings.mjs';
import { protectedHerdr } from './launch-runner.mjs';

function watchLaunchId(arguments_) {
  const [id, ...extra] = arguments_;
  if (extra.length) throw new Error('mac-launch: watch accepts one launch ID.');
  return id;
}

function trackedRun(id) {
  const run = gateStore(STATE_HOME).get(id)?.run;
  if (!run) throw new Error('mac-launch: no tracked run exists for this launch.');
  return run;
}

function requireMatchingTerminal(terminal, run, id) {
  if (terminal.created_ms !== run.createdMs || terminal.labels?.['mac-launch.id'] !== id) {
    throw new Error('mac-launch: Herdr terminal identity changed. Refusing attachment.');
  }
}

export async function watch(arguments_) {
  const id = watchLaunchId(arguments_);
  const context = protectedHerdr(loadSettings());
  const run = trackedRun(id);
  const terminal = JSON.parse(await commandOutput(context.binary, ['get', '--json', run.name], { env: context.env, timeout: 5000 }));
  requireMatchingTerminal(terminal, run, id);
  execFileSync(context.binary, ['attach', run.name], { env: context.env, stdio: 'inherit' });
}
