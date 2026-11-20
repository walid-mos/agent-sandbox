import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { main } from './main.mjs';
import { isServerLogEnabled } from './server-log-events.mjs';
import { sourceRefreshIncidents } from './source-refresh-incidents.mjs';

const INTERVAL_MS = 5 * 60_000;
// A stalled fetch or installer would otherwise hold the provisioning lock, and every later run would wait behind it.
const RUN_LIMIT_MS = 15 * 60_000;
const provisioner = fileURLToPath(new URL('./provision-agents', import.meta.url));
// The provisioner's first run, which bootstrap starts, creates this lock. Before it the session has no credentials to fetch with.
const STATE_DIRECTORY = join(homedir(), '.config/agent-sandbox');
const FIRST_RUN_LOCK = join(STATE_DIRECTORY, 'provisioning.lock');
const INCIDENTS = join(STATE_DIRECTORY, 'server-log', 'source-refresh.sqlite');
const REFRESH_PAUSED = {
  unavailable: 'watch-sources: server-log incident storage is unavailable. Retrying before the next refresh.\n',
  capacity: 'watch-sources: server-log incident storage is full. Waiting for the collector before starting another episode.\n',
};

export function sourceRefresh({ run, isReady, stdout, stderr, notice }) {
  let isRunning = false;
  return () => {
    if (isRunning || !isReady() || (notice && !notice.canRefresh())) return;
    isRunning = true;
    run((error, standardOutput, errorOutput) => {
      notice?.record(error ? 'failure' : 'recovery');
      isRunning = false;
      if (standardOutput) stdout.write(standardOutput);
      if (errorOutput) stderr.write(errorOutput);
      if (error) stderr.write('watch-sources: provisioning failed. The next scheduled refresh retries.\n');
    });
  };
}

export function sourceRefreshNotice(openIncidents, clock, reportPause) {
  let incidents;
  let pending;
  const store = () => incidents ??= openIncidents();
  function flush() {
    if (!pending) return;
    if (pending.outcome === 'failure') store().recordFailure(pending.at);
    else store().recordRecovery(pending.at);
    pending = undefined;
  }
  return {
    canRefresh() {
      try {
        flush();
        if (store().canRefresh()) return true;
      } catch {
        reportPause('unavailable');
        return false;
      }
      reportPause('capacity');
      return false;
    },
    record(outcome) {
      pending = { outcome, at: clock() };
      try { flush(); }
      catch { reportPause('unavailable'); }
    },
  };
}

main(import.meta, () => {
  const { stdout, stderr } = process;
  const notice = isServerLogEnabled()
    ? sourceRefreshNotice(() => sourceRefreshIncidents(INCIDENTS), () => new Date(), reason => stderr.write(REFRESH_PAUSED[reason]))
    : undefined;
  const refresh = sourceRefresh({ run: callback => execFile(provisioner, { timeout: RUN_LIMIT_MS }, callback),
    isReady: () => existsSync(FIRST_RUN_LOCK), stdout, stderr, notice });
  refresh();
  setInterval(refresh, INTERVAL_MS);
});
