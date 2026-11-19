import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discordAdminApi } from './discord-admin-api.mjs';
import { discordAccount, discoverThreadOwnership } from './discord-admin-runtime.mjs';
import { autoThreadDiscord } from './discord-auto-thread-api.mjs';
import { autoThreadPolicy } from './discord-auto-thread-policy.mjs';
import { autoThreadInbox, autoThreadState } from './discord-auto-thread-store.mjs';
import { applyAutoThread } from './discord-auto-thread.mjs';

const POLL_MS = 2000;
const STATE_PATH = join(homedir(), '.config/agent-sandbox/discord-auto-threads/progress.sqlite');
const PROTECTION_DIRECTORY = join(homedir(), '.config/agent-sandbox/discord-admin');

function progressOf(state, inbox, policy, now) {
  const scope = JSON.stringify([inbox.identity, policy.guildId, [...policy.rules]]);
  const saved = state.progress();
  const cursor = inbox.latest();
  if (saved?.scope === scope && saved.cursor <= cursor) return saved;
  const progress = { scope, cursor, since: now };
  state.save(progress);
  return progress;
}

async function consume(row, progress, dependencies, onError) {
  const message = JSON.parse(row.message);
  if (!(Date.parse(message.timestamp) >= progress.since)) return;
  try {
    await applyAutoThread({ message, inThread: Boolean(row.thread) }, dependencies);
  } catch (error) {
    const code = Number.isInteger(error?.discordCode) ? ` Discord code ${error.discordCode}.` : '';
    onError(`Event ${row.id} did not confirm a thread.${code} Inspect Discord before trying manually.`);
  }
}

export function autoThreadPoll(inbox, state, dependencies, onError, now = Date.now()) {
  const progress = progressOf(state, inbox, dependencies.policy, now);
  return async () => {
    for (const row of inbox.after(progress.cursor)) {
      await consume(row, progress, { ...dependencies, claim: state.claim }, onError);
      state.save({ ...progress, cursor: row.id });
      progress.cursor = row.id;
    }
  };
}

function disableWatcher() {
  if (!existsSync(STATE_PATH)) return;
  const state = autoThreadState(STATE_PATH);
  try { state.disable(); }
  finally { state.close(); }
}

function connect(config, primaryHome, policy, onError) {
  const account = discordAccount(primaryHome);
  const api = discordAdminApi(account.secrets);
  const state = autoThreadState(STATE_PATH);
  let inbox;
  try {
    inbox = autoThreadInbox(join(primaryHome, 'bot.sqlite'), account.id);
    const ownership = () => discoverThreadOwnership({ api, config, primaryHome, stateDirectory: PROTECTION_DIRECTORY });
    return autoThreadPoll(inbox, state, { policy, discord: autoThreadDiscord(api), ownership }, onError);
  } catch (error) {
    inbox?.close();
    state.close();
    throw error;
  }
}

export function startAutoThreads(config, primaryHome, onError) {
  const policy = autoThreadPolicy(config);
  if (!policy) return disableWatcher();
  let poll;
  let reportedReadFailure = false;
  async function next() {
    try {
      poll ??= connect(config, primaryHome, policy, onError);
      await poll();
      reportedReadFailure = false;
    } catch {
      if (!reportedReadFailure) onError('Cannot read the gateway log or save automatic thread progress. Check the Mastermind account and local state.');
      reportedReadFailure = true;
    }
    setTimeout(next, POLL_MS);
  }
  void next();
}
