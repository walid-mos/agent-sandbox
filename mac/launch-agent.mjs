import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDiscordPolicy, LAUNCH_POLICY } from '../session/human-contract.mjs';
import { loadSettings } from './launch-settings.mjs';

const LABEL = 'fr.nextnode.agent-sandbox.mac-launch';
const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library/Logs/agent-sandbox/mac-launch.log');
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const domain = () => `gui/${process.getuid()}`;

const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function plistValue(value, depth) {
  const pad = '\t'.repeat(depth);
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (Number.isInteger(value)) return `${pad}<integer>${value}</integer>`;
  if (typeof value === 'string') return `${pad}<string>${escape(value)}</string>`;
  if (Array.isArray(value)) return [`${pad}<array>`, ...value.map(item => plistValue(item, depth + 1)), `${pad}</array>`].join('\n');
  return [`${pad}<dict>`, ...Object.keys(value).sort().flatMap(key => [`${pad}\t<key>${escape(key)}</key>`, plistValue(value[key], depth + 1)]), `${pad}</dict>`].join('\n');
}

function launchAgentPlist(settings) {
  const agent = { Label: LABEL, ProgramArguments: [join(REPOSITORY, 'mac/launch-gate'), 'serve'], WorkingDirectory: REPOSITORY,
    EnvironmentVariables: { PATH: [...settings.path, ...SYSTEM_PATH].join(':') }, RunAtLoad: true, KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30, StandardOutPath: LOG, StandardErrorPath: LOG };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(agent, 0)}\n</plist>\n`;
}

const onMac = () => { if (process.platform !== 'darwin') throw new Error('mac-launch: install this service on its Mac only.'); };
// launchctl refuses to load a label it already holds, and fails to unload one it does not.
const unload = () => { try { execFileSync('launchctl', ['bootout', `${domain()}/${LABEL}`], { stdio: 'ignore' }); } catch {} };

export function install() {
  onMac();
  const settings = loadSettings();
  checkDiscordPolicy(LAUNCH_POLICY, settings.humanDiscord);
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(LOG), { recursive: true });
  closeSync(openSync(LOG, 'a', 0o600));
  writeFileSync(PLIST, launchAgentPlist(settings));
  chmodSync(PLIST, 0o600);
  unload();
  execFileSync('launchctl', ['bootstrap', domain(), PLIST], { stdio: 'inherit' });
  console.log('Mac launch service installed. No inbound port was opened.');
}

export function remove() {
  onMac();
  unload();
  rmSync(PLIST, { force: true });
  console.log('Mac launch login service removed.');
}
