import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { main } from './main.mjs';

const INTERVAL_MS = 5 * 60_000;
// A stalled fetch or installer would otherwise hold the provisioning lock, and every later run would wait behind it.
const RUN_LIMIT_MS = 15 * 60_000;
const provisioner = fileURLToPath(new URL('./provision-agents', import.meta.url));
// The provisioner's first run, which bootstrap starts, creates this lock. Before it the session has no credentials to fetch with.
const FIRST_RUN_LOCK = join(homedir(), '.config/agent-sandbox/provisioning.lock');
let isRunning = false;
function refresh() {
  if (isRunning || !existsSync(FIRST_RUN_LOCK)) return;
  isRunning = true;
  execFile(provisioner, { timeout: RUN_LIMIT_MS }, (error, stdout, stderr) => {
    isRunning = false;
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (error) process.stderr.write('watch-sources: provisioning failed. The next scheduled refresh retries.\n');
  });
}
main(import.meta, () => {
  refresh();
  setInterval(refresh, INTERVAL_MS);
});
