import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { main } from './main.mjs';
import { writePrivateJson } from './private-json.mjs';
import { isServerLogEnabled, serverLogEvent, SERVER_LOG_EVENT } from './server-log-events.mjs';

const INTERVAL_MS = 5 * 60_000;
// A stalled fetch or installer would otherwise hold the provisioning lock, and every later run would wait behind it.
const RUN_LIMIT_MS = 15 * 60_000;
const provisioner = fileURLToPath(new URL('./provision-agents', import.meta.url));
// The provisioner's first run, which bootstrap starts, creates this lock. Before it the session has no credentials to fetch with.
const STATE_DIRECTORY = join(homedir(), '.config/agent-sandbox');
const FIRST_RUN_LOCK = join(STATE_DIRECTORY, 'provisioning.lock');
const LATEST_WARNING = join(STATE_DIRECTORY, 'server-log', 'source-refresh.json');

export function sourceRefresh({ run, isReady, stdout, stderr, notice }) {
  let isRunning = false;
  return () => {
    if (isRunning || !isReady()) return;
    isRunning = true;
    run((error, standardOutput, errorOutput) => {
      isRunning = false;
      if (standardOutput) stdout.write(standardOutput);
      if (errorOutput) stderr.write(errorOutput);
      if (error) stderr.write('watch-sources: provisioning failed. The next scheduled refresh retries.\n');
      notice?.(error);
    });
  };
}

export function sourceRefreshNotice(path, clock, reportWriteFailure) {
  let hasRecordedFailure = false;
  return error => {
    if (!error) {
      hasRecordedFailure = false;
      return;
    }
    if (hasRecordedFailure) return;
    try {
      writePrivateJson(path, serverLogEvent(SERVER_LOG_EVENT.sourceRefreshFailed, clock()));
      hasRecordedFailure = true;
    } catch {
      reportWriteFailure();
    }
  };
}

main(import.meta, () => {
  const { stdout, stderr } = process;
  const notice = isServerLogEnabled() ? sourceRefreshNotice(LATEST_WARNING, () => new Date(), () => {
    stderr.write('watch-sources: could not record the server-log warning. The next failed refresh retries the write.\n');
  }) : undefined;
  const refresh = sourceRefresh({ run: callback => execFile(provisioner, { timeout: RUN_LIMIT_MS }, callback),
    isReady: () => existsSync(FIRST_RUN_LOCK), stdout, stderr, notice });
  refresh();
  setInterval(refresh, INTERVAL_MS);
});
