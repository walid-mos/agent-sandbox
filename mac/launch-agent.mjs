import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CODE_HOME, GATE_HOME, gateEnvironment } from './launch-execution-contract.mjs';
import { checkNativeIsolation } from './launch-native.mjs';
import { protectedPath, requireGate } from './launch-protection.mjs';
import { loadSettings } from './launch-settings.mjs';

const LABEL = 'fr.nextnode.agent-sandbox.mac-launch';
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
const LOG = join(GATE_HOME, 'gate.log');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function plistScalar(value, pad) {
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (Number.isInteger(value)) return `${pad}<integer>${value}</integer>`;
  if (typeof value === 'string') return `${pad}<string>${escape(value)}</string>`;
  return undefined;
}

function plistArray(value, pad, depth) {
  return [`${pad}<array>`, ...value.map(item => plistValue(item, depth + 1)), `${pad}</array>`].join('\n');
}

function plistDictionary(value, pad, depth) {
  return [`${pad}<dict>`, ...Object.keys(value).sort().flatMap(key => [`${pad}\t<key>${escape(key)}</key>`, plistValue(value[key], depth + 1)]), `${pad}</dict>`].join('\n');
}

function plistValue(value, depth) {
  const pad = '\t'.repeat(depth);
  const scalar = plistScalar(value, pad);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) return plistArray(value, pad, depth);
  return plistDictionary(value, pad, depth);
}

function launchDaemonPlist(settings) {
  const daemon = { Label: LABEL, UserName: 'root', GroupName: 'wheel', ProgramArguments: [settings.tools.node, join(CODE_HOME, 'mac/launch-cli.mjs'), 'serve'],
    WorkingDirectory: CODE_HOME, EnvironmentVariables: gateEnvironment(), RunAtLoad: true, KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30, StandardOutPath: LOG, StandardErrorPath: LOG, Umask: 0o077 };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(daemon, 0)}\n</plist>\n`;
}

function unload() {
  const result = execFileSync('/bin/launchctl', ['print', `system/${LABEL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result) execFileSync('/bin/launchctl', ['bootout', `system/${LABEL}`], { stdio: 'inherit' });
}

export function install() {
  const settings = loadSettings();
  checkNativeIsolation(settings);
  protectedPath(dirname(PLIST));
  closeSync(openSync(LOG, 'a', 0o600));
  writeFileSync(PLIST, launchDaemonPlist(settings), { flag: 'wx', mode: 0o644 });
  chmodSync(PLIST, 0o644);
  execFileSync('/bin/launchctl', ['bootstrap', 'system', PLIST], { env: gateEnvironment(), stdio: 'inherit' });
  console.log('Protected system launch gate installed. No inbound port was opened.');
}

export function remove() {
  requireGate();
  protectedPath(PLIST);
  unload();
  rmSync(PLIST);
  console.log('Protected launch gate removed. Decisions and execution records were retained.');
}
