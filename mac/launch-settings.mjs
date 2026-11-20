import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isTarget } from '../session/launch-contract.mjs';
import { isSnowflake } from '../session/human-contract.mjs';
import { writePrivateJson } from '../session/private-json.mjs';
import { readPrivate, privateDirectory } from './launch-store.mjs';
import { GATE_HOME, checkedExecution } from './launch-execution-contract.mjs';
import { protectedPath, readSecret, requireGate } from './launch-protection.mjs';

const SETTINGS = join(GATE_HOME, 'settings.json');
const TOKEN = join(GATE_HOME, 'discord-token');
const INVALID_SETTINGS = 'mac-launch: settings contain invalid names or IDs.';
export const STATE_HOME = join(GATE_HOME, 'launches');

function requireSettingsLists(settings) {
  if (!Array.isArray(settings.announcers) || !Array.isArray(settings.pots)) throw new Error('mac-launch: settings need announcers and pots lists.');
}

function requireTargetLabel(settings) {
  if (!isTarget(settings.name) || typeof settings.label !== 'string' || !/^[A-Za-z0-9 -]{1,50}$/.test(settings.label)) throw new Error(INVALID_SETTINGS);
}

function requirePots(settings) {
  if (settings.pots.length === 0 || !settings.pots.every(isTarget)) throw new Error(INVALID_SETTINGS);
}

function requireAnnouncers(settings) {
  if (settings.announcers.length === 0 || !settings.announcers.every(isSnowflake)) throw new Error(INVALID_SETTINGS);
}

function requireSettingIds(settings) {
  const ids = [settings.guildId, settings.channelId, settings.humanDiscord?.userId];
  if (!ids.every(isSnowflake)) throw new Error(INVALID_SETTINGS);
}

function checkedSettings(settings) {
  requireSettingsLists(settings);
  requireTargetLabel(settings);
  requirePots(settings);
  requireAnnouncers(settings);
  requireSettingIds(settings);
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
  writePrivateJson(SETTINGS, settings);
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
