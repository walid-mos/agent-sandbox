import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureImage, probe } from '../session/factory-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = randomUUID();
const name = `repository-read-proof-${run}`;
const label = 'agent-sandbox.repository-read-proof';
const timeout = 120_000;
console.log(probe());
const image = ensureImage();
try {
  const result = spawnSync('docker', ['run', '--rm', '--name', name, '--label', `${label}=${run}`,
    '--network', 'none', '--add-host', 'github.com:127.0.0.1', '--cap-drop', 'ALL',
    ...['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'].flatMap(capability => ['--cap-add', capability]),
    '--security-opt', 'no-new-privileges', '--pids-limit', '2048', '--memory', '1g', '--user', '0',
    '--env', 'REPOSITORY_READ_DISPOSABLE_VM=1', '--volume', `${root}:/work/repository:ro`,
    '--workdir', '/work/repository', image, 'python3', '-B', 'probes/repository-read-vm.py'], { stdio: 'inherit', timeout });
  if (result.error) console.error(`Repository read container failed: ${result.error.code}`);
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  const identity = spawnSync('docker', ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name], { encoding: 'utf8' });
  if (identity.status === 0 && identity.stdout.trim() === run) {
    const removed = spawnSync('docker', ['rm', '--force', name], { stdio: 'inherit' });
    if (removed.status !== 0) process.exitCode = 1;
  }
}
