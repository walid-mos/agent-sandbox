import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factoryCommand, WATCH } from './factory-reports.mjs';
import { FACTORY_BOT } from './factory-identity.mjs';
import { FACTORY_TOPIC } from './factory-github.mjs';
import { linkFolder } from './link.mjs';
import { main } from './main.mjs';
import { ensureRouterBot } from './router-bot.mjs';
import { command } from './run.mjs';
import { owners } from './sandbox.mjs';
import { isRetiredSessionFactory } from './factory-authority.mjs';

const VERSIONED = join(dirname(fileURLToPath(import.meta.url)), 'factory');
const SCAN_EVERY = '1m';
const SCAN_TIMEOUT = '30m';
const ABOUT = `checks, judges and merges ready pull requests in repositories with the ${FACTORY_TOPIC} topic`;
const HOLD_SOURCE = 'factory-install';
const HOLD_FOR = '365d';
const HOLD_NOTE = 'This wake only holds back the fallback check-in. Do nothing: the next session bootstrap sets it again.';
const READY_TIMEOUT_MS = 60000;
const READY_POLL_MS = 1000;

const pots = arguments_ => execFileSync('pots', arguments_, { stdio: 'inherit' });

// The gateway starts a new bot, or comes back from its restart, a few seconds after the command, and adds a routine only to a running bot.
function waitUntilRunning() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (spawnSync('pots', ['routine', 'list', '--bot', FACTORY_BOT.id], { stdio: 'ignore' }).status !== 0) {
    if (Date.now() > deadline) throw new Error(`factory: the gateway did not run ${FACTORY_BOT.name} within a minute. Check pots status, then run this again.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READY_POLL_MS);
  }
}

// Pots wakes a bot every two hours while no wake set with pots wake is pending, and ignores fallbackWakeMinutes in bot.json. The scan routine does the looking, so one far wake holds that check-in back.
function holdCheckIn() {
  const pending = JSON.parse(command('pots', ['wake', '--bot', FACTORY_BOT.id, '--list']));
  if (pending.some(wake => wake.source === HOLD_SOURCE)) return;
  command('pots', ['wake', '--bot', FACTORY_BOT.id, '--in', HOLD_FOR, '--from', HOLD_SOURCE, '--note', HOLD_NOTE]);
}

main(import.meta, () => {
  if (isRetiredSessionFactory) {
    process.stdout.write('factory: this factory runs in its own VM-started container. No session routine is installed.\n');
    return;
  }
  if (owners.length === 0) {
    process.stdout.write('factory: this pot owns no repositories, so it runs no Factory bot\n');
    return;
  }
  linkFolder(VERSIONED, ensureRouterBot(FACTORY_BOT, ABOUT));
  waitUntilRunning();
  holdCheckIn();
  pots(['routine', 'add', WATCH, '--bot', FACTORY_BOT.id, '--every', SCAN_EVERY, '--timeout', SCAN_TIMEOUT, '--run', factoryCommand('scan')]);
  process.stdout.write(`factory: ${FACTORY_BOT.name} follows ${VERSIONED} and scans repositories of ${owners.join(', ')} with the ${FACTORY_TOPIC} topic every ${SCAN_EVERY}\n`);
});
