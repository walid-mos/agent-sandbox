import { isPotName } from './door-messages.mjs';
import { all, find, RESENDABLE } from './door-requests.mjs';
import { checkSent, ownName, prepareBoardAsk, prepareReply, transmitAsync } from './doors.mjs';
import { watchedRepositories } from './factory-github.mjs';
import { recordedHeads } from './factory-records.mjs';
import { humanStore } from './human-store.mjs';
import { main } from './main.mjs';
import { PASS_MS, REPOSITORY } from './pr-board-contract.mjs';
import { discordClient } from './pr-board-discord.mjs';
import { factoryEvents } from './pr-board-events.mjs';
import { githubPulls } from './pr-board-github.mjs';
import { runBoardPass } from './pr-board-pass.mjs';
import { collectPulls } from './pr-board-source.mjs';
import { boardStore, withBoardLock } from './pr-board-store.mjs';
import { botId, isMastermind, owners, sandbox } from './sandbox.mjs';
import { isStopped, workers } from './workers.mjs';

function validateSources(configuration) {
  const sources = configuration.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) || Object.keys(sources).length > 16) throw new Error('pr-board: configure a private source-to-repository grant map.');
  for (const [pot, repositories] of Object.entries(sources)) {
    if (!isPotName(pot) || !Array.isArray(repositories) || repositories.length > 1000 || !repositories.every(repository => REPOSITORY.test(repository))) throw new Error('pr-board: invalid private source grant.');
  }
}

const doors = {
  all, find, prepare: prepareBoardAsk, transmitAsync,
  reply: async (id, reply) => {
    const request = prepareReply(id, reply);
    if (RESENDABLE.includes(request.state)) checkSent(await transmitAsync(request));
  },
};

function options() {
  const configuration = sandbox.pullRequestBoard;
  if (isMastermind) validateSources(configuration);
  return { configuration, isMastermind, pot: ownName(), store: boardStore(), doors,
    discord: isMastermind ? discordClient(configuration, botId) : undefined,
    source: { events: factoryEvents, collect: now => collectPulls({ workers, isStopped, owners, factory: recordedHeads,
      dialogs: () => humanStore().all(), watched: watchedRepositories, pulls: githubPulls }, now) },
    onError: message => process.stderr.write(`pr-board: ${message}\n`) };
}

main(import.meta, async () => {
  if (process.argv.slice(2).some(argument => argument !== '--run')) throw new Error('usage: pr-board.mjs [--run]');
  if (sandbox.pullRequestBoard?.enabled !== true) return;
  const configured = options();
  const pass = () => withBoardLock(() => runBoardPass({ ...configured, now: Date.now() }));
  if (process.argv.includes('--run')) return pass();
  async function repeat() {
    try { await pass(); } catch { configured.onError('Board pass failed. Saved progress remains for retry.'); }
    setTimeout(repeat, PASS_MS);
  }
  await repeat();
});
