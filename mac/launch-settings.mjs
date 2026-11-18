import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_REFUSED_ACTS, isAct, isTarget } from '../session/launch-contract.mjs';
import { isSnowflake } from '../session/human-contract.mjs';
import { writePrivateJson } from '../session/private-json.mjs';
import { readPrivate, privateDirectory } from './launch-store.mjs';
import { GATE_HOME, checkedExecution } from './launch-execution-contract.mjs';
import { protectedPath, readSecret, requireGate } from './launch-protection.mjs';

const SETTINGS = join(GATE_HOME, 'settings.json');
const TOKEN = join(GATE_HOME, 'discord-token');
export const STATE_HOME = join(GATE_HOME, 'launches');

function checkedSettings(settings) {
  const hasLists = ['announcers', 'pots', 'refusedActs'].every(key => Array.isArray(settings[key]));
  if (!hasLists) throw new Error('mac-launch: settings need announcers, pots and refusedActs lists.');
  const hasNames = isTarget(settings.name) && typeof settings.label === 'string' && /^[A-Za-z0-9 -]{1,50}$/.test(settings.label)
    && settings.pots.length > 0 && settings.pots.every(isTarget) && settings.announcers.length > 0 && settings.announcers.every(isSnowflake);
  const hasIds = [settings.guildId, settings.channelId, settings.humanDiscord?.userId].every(isSnowflake);
  if (!hasNames || !hasIds || !settings.refusedActs.every(isAct)) throw new Error('mac-launch: settings contain invalid names, IDs or acts.');
  checkedExecution(settings);
  return settings;
}

export function loadSettings() {
  requireGate();
  protectedPath(SETTINGS);
  return checkedSettings(readPrivate(SETTINGS));
}

export function configure(source) {
  requireGate();
  protectedPath(source);
  const settings = checkedSettings(readPrivate(source));
  protectedPath(GATE_HOME);
  privateDirectory(GATE_HOME);
  writePrivateJson(SETTINGS, { ...settings, refusedActs: [...new Set([...DEFAULT_REFUSED_ACTS, ...settings.refusedActs])],
    humanDiscord: { ...settings.humanDiscord, macLaunchEnabled: false } });
}

export function setEnabled(isEnabled) {
  const settings = loadSettings();
  writePrivateJson(SETTINGS, { ...settings, humanDiscord: { ...settings.humanDiscord, macLaunchEnabled: isEnabled } });
}

export async function storeToken() {
  requireGate();
  if (!process.stdin.isTTY) throw new Error('mac-launch: enter the dedicated gate token yourself in a Mac terminal.');
  protectedPath(GATE_HOME);
  privateDirectory(GATE_HOME);
  process.stderr.write('Dedicated gate Discord token: ');
  const restore = () => execFileSync('/bin/stty', ['echo'], { stdio: 'inherit' });
  const interrupt = () => { restore(); process.exit(130); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  execFileSync('/bin/stty', ['-echo'], { stdio: 'inherit' });
  const input = createInterface({ input: process.stdin, terminal: false });
  try {
    const token = (await new Promise((resolve, reject) => {
      input.once('line', resolve);
      input.once('close', () => reject(new Error('mac-launch: token entry ended without a value.')));
    })).trim();
    if (!token || /\s/.test(token)) throw new Error('mac-launch: expected one token. No token saved.');
    writeFileSync(TOKEN, token, { mode: 0o600, flag: 'w' });
    chmodSync(TOKEN, 0o600);
  } finally {
    input.close();
    restore();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    process.stderr.write('\n');
  }
}

export function gateToken() {
  requireGate();
  const token = readSecret(TOKEN).trim();
  if (!token) throw new Error('mac-launch: no dedicated gate token is installed.');
  return token;
}
