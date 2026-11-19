import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ROUTER_MODEL } from './models.mjs';
import { potsBotHome } from './sandbox.mjs';

export function ensureRouterBot({ id, name }, about, { stdio = 'inherit' } = {}) {
  const home = potsBotHome(id);
  if (existsSync(home)) return home;
  execFileSync('pots', ['bot', 'new', name, '--id', id, '--model', ROUTER_MODEL, '--judge', 'off', '--about', about], { stdio });
  if (!existsSync(home)) throw new Error(`${id}: pots bot new made no ${home}. Check pots status, then run this again.`);
  return home;
}
