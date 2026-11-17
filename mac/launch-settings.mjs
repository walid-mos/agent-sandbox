import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ACTS, DEFAULT_REFUSED_ACTS, isTarget } from '../session/launch-contract.mjs';
import { isSnowflake } from '../session/human-contract.mjs';
import { readPrivate, privateDirectory, writePrivate } from './launch-store.mjs';

const SETTINGS = join(homedir(), '.config/agent-sandbox/mac-launch.json');
export const STATE_HOME = join(homedir(), '.config/agent-sandbox/mac-launch');
const KEYCHAIN_SERVICE = 'agent-sandbox-mac-launch';

function checkedSettings(settings) {
  const hasLists = ['announcers', 'pots', 'refusedActs', 'path', 'piArguments'].every(key => Array.isArray(settings[key]));
  if (!hasLists) throw new Error('mac-launch: settings need announcers, pots, refusedActs, path and piArguments lists. Run configure.');
  const hasNames = isTarget(settings.name) && typeof settings.label === 'string' && /^[A-Za-z0-9 -]{1,50}$/.test(settings.label)
    && settings.pots.length > 0 && settings.pots.every(isTarget) && settings.announcers.length > 0 && settings.announcers.every(isSnowflake);
  const hasIds = [settings.guildId, settings.channelId, settings.humanDiscord?.userId].every(isSnowflake);
  const hasPaths = typeof settings.directory === 'string' && isAbsolute(settings.directory) && settings.path.every(path => typeof path === 'string' && isAbsolute(path));
  const hasActs = settings.refusedActs.every(act => Object.hasOwn(ACTS, act));
  if (!hasNames || !hasIds || !hasPaths || !hasActs || !settings.piArguments.every(argument => typeof argument === 'string')) throw new Error('mac-launch: settings contain invalid names, IDs, paths or acts. Run configure.');
  return settings;
}

export const loadSettings = () => checkedSettings(readPrivate(SETTINGS));

export function configure(values) {
  const settings = checkedSettings({ name: values.name, label: values.label, guildId: values.guild, channelId: values.channel,
    humanDiscord: { userId: values.operator, macLaunchEnabled: false }, announcers: values.announcer?.split(','), pots: values.pots?.split(','),
    refusedActs: DEFAULT_REFUSED_ACTS, directory: values.directory ?? homedir(), path: ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')], piArguments: [] });
  privateDirectory(join(homedir(), '.config/agent-sandbox'));
  writePrivate(SETTINGS, settings);
}

export function setEnabled(isEnabled) {
  const settings = loadSettings();
  writePrivate(SETTINGS, { ...settings, humanDiscord: { ...settings.humanDiscord, macLaunchEnabled: isEnabled } });
}

export function storeToken() {
  if (process.platform !== 'darwin' || !process.stdin.isTTY) throw new Error('mac-launch: run token yourself in a terminal on the Mac.');
  execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-a', userInfo().username, '-s', KEYCHAIN_SERVICE, '-w'], { stdio: 'inherit' });
}

export function keychainToken() {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('mac-launch: no launch token in this Mac\'s login keychain. Run launch-gate token yourself.');
  }
}
