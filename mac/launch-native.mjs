import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_HOME, GATE_HOME, gateEnvironment } from './launch-execution-contract.mjs';
import { checkProtectedInstallation, protectedPath } from './launch-protection.mjs';

const NATIVE_MS = 15_000;

export function checkNativeAccount(settings) {
  checkProtectedInstallation(settings);
  const { execution } = settings;
  const id = flag => execFileSync('/usr/bin/id', [flag, execution.user], { encoding: 'utf8', env: gateEnvironment() }).trim();
  if (id('-u') !== `${execution.uid}` || id('-g') !== `${execution.gid}` || id('-G').split(/\s+/).some(gid => gid !== `${execution.gid}`)) {
    throw new Error('mac-launch: the execution account must match the dedicated UID/GID and have no other groups.');
  }
  const accounts = execFileSync('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID'], { encoding: 'utf8', env: gateEnvironment() });
  const aliases = accounts.trim().split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.at(-1) === `${execution.uid}`);
  if (aliases.length !== 1 || aliases[0][0] !== execution.user) throw new Error('mac-launch: the execution UID must belong only to the dedicated account.');
  const shell = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${execution.user}`, 'UserShell'], { encoding: 'utf8', env: gateEnvironment() });
  if (!/^UserShell: \/(?:usr\/bin\/false|sbin\/nologin)\s*$/.test(shell)) throw new Error('mac-launch: the execution account must have a disabled login shell.');
  const sudo = spawnSync('/usr/bin/sudo', ['-n', '-U', execution.user, '-l'], { env: gateEnvironment(), timeout: NATIVE_MS, stdio: 'ignore' });
  if (sudo.error || sudo.status !== 1) throw new Error('mac-launch: cannot prove the execution account has no sudo delegation. Refusing execution.');
  if (!existsSync('/usr/bin/sandbox-exec')) throw new Error('mac-launch: native sandbox-exec is unavailable on this Mac. Activation is blocked.');
  protectedPath('/usr/bin/sandbox-exec');
}

export function prepareGateEnvironment() {
  for (const name of ['config', 'data', 'state', 'cache', 'tmp']) {
    const folder = join(GATE_HOME, name);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    protectedPath(folder);
    if (lstatSync(folder).mode & 0o077) throw new Error('mac-launch: gate context directories must be private.');
  }
}

export function checkNativeIsolation(settings) {
  checkNativeAccount(settings);
  prepareGateEnvironment();
  const probe = spawnSync(settings.tools.node, [join(CODE_HOME, 'mac/launch-native-probe.mjs')],
    { env: gateEnvironment(), cwd: CODE_HOME, encoding: 'utf8', timeout: NATIVE_MS, maxBuffer: 16_384 });
  const answer = probe.stdout?.trim() ?? '';
  if (probe.error || probe.status !== 0 || answer !== 'native-isolation-ok') {
    const reason = /^native-isolation-failed: [a-z, ]+$/.test(answer) ? answer : `native sandbox/probe exited ${probe.status ?? 'without a result'}`;
    throw new Error(`mac-launch: ${reason}. Activation is blocked. Native isolation has not been proved.`);
  }
}
