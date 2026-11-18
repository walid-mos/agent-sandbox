import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDiscordPolicy, LAUNCH_POLICY } from '../session/human-contract.mjs';
import { LAUNCH_TTL_MS } from '../session/launch-contract.mjs';
import { command, commandOutput } from '../session/run.mjs';
import { discordClient } from './launch-discord.mjs';
import { potTransport } from './launch-pots.mjs';
import { herdrRunner, protectedHerdr } from './launch-runner.mjs';
import { checkNativeIsolation } from './launch-native.mjs';
import { launchService } from './launch-service.mjs';
import { gateToken, loadSettings, STATE_HOME } from './launch-settings.mjs';
import { gateStore, readPrivate } from './launch-store.mjs';

const POLL_MS = 5000;
const warn = message => process.stderr.write(`${message}\n`);
const COMMAND_MS = 10_000;

export async function check() {
  const config = loadSettings();
  checkNativeIsolation(config);
  console.log('Protected installation, separate UID/GID, native sandbox and privilege denial: valid.');
  const context = protectedHerdr(config);
  const client = discordClient(gateToken());
  await client.check(config);
  console.log('Discord bot, intent, channel and operator membership: valid.');
  for (const tool of ['node', 'hc']) {
    await commandOutput(config.tools[tool], ['--version'], { timeout: COMMAND_MS, env: context.env, cwd: context.directory });
    console.log(`${tool}: protected runtime available.`);
  }
  const pots = potTransport(context);
  for (const pot of config.pots) {
    await pots.reach(pot);
    console.log(`Herdr reaches ${pot}.`);
  }
}

// A crashed gate's PID is given to another process later, so the lock names its owner by start time too.
function processStart(pid) {
  try { return command('ps', ['-o', 'lstart=', '-p', `${pid}`]); } catch { return undefined; }
}

export function lockService(folder, processStartFor = processStart) {
  const path = join(folder, 'service.lock');
  if (existsSync(path)) {
    const previous = readPrivate(path);
    const started = processStartFor(previous.pid);
    if (started && started === previous.started) throw new Error('mac-launch: a gate is already running.');
    rmSync(path);
  }
  const owner = { pid: process.pid, started: processStartFor(process.pid) };
  writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  const release = () => {
    if (existsSync(path) && readPrivate(path).pid === owner.pid) rmSync(path);
  };
  process.on('exit', release);
  return release;
}

async function offerHistoricalMessage(service, config, applicationId, message) {
  try { await service.notice({ ...message, guild_id: config.guildId }, applicationId); }
  catch { warn('mac-launch: a historical notice was refused.'); }
}

async function offerRecentMessages(service, config, applicationId, messages) {
  const recent = messages.filter(message => Date.now() - Date.parse(message.timestamp) < LAUNCH_TTL_MS);
  for (const message of recent.reverse()) await offerHistoricalMessage(service, config, applicationId, message);
  return recent.length === messages.length && messages.length === 100 ? messages.at(-1).id : undefined;
}

async function history(client, service, config, applicationId) {
  let before;
  do {
    const messages = await client.history(config.channelId, before);
    if (!messages.length) return;
    before = await offerRecentMessages(service, config, applicationId, messages);
  } while (before);
}

export async function serve() {
  const config = loadSettings();
  checkDiscordPolicy(LAUNCH_POLICY, config.humanDiscord);
  checkNativeIsolation(config);
  const context = protectedHerdr(config);
  const store = gateStore(STATE_HOME);
  const release = lockService(STATE_HOME);
  const client = discordClient(gateToken());
  const service = launchService({ store, discord: client, pots: potTransport(context), runner: herdrRunner(context), settings: loadSettings, warn });
  let applicationId;
  let pending = Promise.resolve();
  const enqueue = operation => { pending = pending.then(operation).catch(() => warn('mac-launch: event refused or unavailable. No approval was inferred.')); return pending; };
  const close = client.listen((kind, event) => {
    if (kind === 'READY') {
      applicationId = event.application.id;
      enqueue(() => history(client, service, loadSettings(), applicationId));
    }
    if (kind === 'MESSAGE_CREATE' && applicationId) enqueue(() => service.notice(event, applicationId));
    if (kind === 'INTERACTION_CREATE' && applicationId) {
      // Discord drops a press nobody answers within three seconds, so the answer never waits behind the queue. It decides nothing.
      client.acknowledge(event).catch(() => warn('mac-launch: Discord did not take the answer to a press.'));
      enqueue(() => service.press(event));
    }
  }, error => { warn(error.message); stop(); process.exitCode = 1; });
  let timer;
  // The next pass starts only once this one ended, so a slow pot call cannot pile passes up ahead of the operator's press.
  async function poll() {
    try { checkDiscordPolicy(LAUNCH_POLICY, loadSettings().humanDiscord); }
    catch (error) { warn(error.message); stop(); process.exitCode = 1; return; }
    await enqueue(() => service.tick());
    if (timer !== undefined) timer = setTimeout(poll, POLL_MS);
  }
  timer = setTimeout(poll, POLL_MS);
  function stop() { clearTimeout(timer); timer = undefined; close(); release(); }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
