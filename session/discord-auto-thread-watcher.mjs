import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discordAdminApi } from './discord-admin-api.mjs';
import { discordAccount, discoverThreadOwnership } from './discord-admin-runtime.mjs';
import { autoThreadDiscord } from './discord-auto-thread-api.mjs';
import { autoThreadPolicy } from './discord-auto-thread-policy.mjs';
import { autoThreadInbox, autoThreadState, UnsupportedPotsLog } from './discord-auto-thread-store.mjs';
import { applyAutoThread } from './discord-auto-thread.mjs';

const POLL_MS = 2000;
const STATE_PATH = join(homedir(), '.config/agent-sandbox/discord-auto-threads/progress.sqlite');
const PROTECTION_DIRECTORY = join(homedir(), '.config/agent-sandbox/discord-admin');

function sameActivation(first, second) {
  return first?.scope === second.scope && first.since === second.since;
}

function progressOf(state, inbox, policy, now, activation) {
  const scope = JSON.stringify([inbox.identity, policy.guildId, [...policy.rules]]);
  const saved = state.progress();
  if (activation?.scope === scope) return sameActivation(saved, activation) ? saved : undefined;
  if (activation && saved?.scope !== scope && !sameActivation(saved, activation)) return;
  const cursor = inbox.latest();
  if (saved?.scope === scope && saved.cursor <= cursor) return saved;
  const progress = { scope, cursor, since: now };
  if (!inbox.isCurrent() || !state.reset(progress, saved)) throw new Error('Automatic thread progress changed while opening the gateway log.');
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

export function autoThreadPoll(inbox, state, dependencies, onError, now = Date.now) {
  const { policy } = dependencies;
  let activation = progressOf(state, inbox.refresh(), policy, now());
  return async () => {
    try {
      const reader = inbox.refresh();
      const progress = progressOf(state, reader, policy, now(), activation);
      if (!progress) return;
      activation = progress;
      const claim = id => reader.isCurrent() && state.claim(progress, id);
      for (const row of reader.after(progress.cursor)) {
        if (!reader.isCurrent()) break;
        await consume(row, progress, { ...dependencies, claim }, onError);
        state.advance(progress, row.id);
      }
    } catch (error) {
      inbox.close();
      throw error;
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
  let reportedReadFailure;
  async function next() {
    try {
      poll ??= connect(config, primaryHome, policy, onError);
      await poll();
      reportedReadFailure = undefined;
    } catch (error) {
      const failure = error instanceof UnsupportedPotsLog
        ? 'Unsupported Pots gateway log schema. Automatic threads are paused until a supported log is available.'
        : 'Cannot read the gateway log or save automatic thread progress. Check the Mastermind account and local state.';
      if (reportedReadFailure !== failure) onError(failure);
      reportedReadFailure = failure;
    }
    setTimeout(next, POLL_MS);
  }
  void next();
}
