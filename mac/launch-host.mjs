import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDiscordPolicy, LAUNCH_POLICY } from '../session/human-contract.mjs';
import { LAUNCH_TTL_MS } from '../session/launch-contract.mjs';
import { command, commandOutput } from '../session/run.mjs';
import { discordClient } from './launch-discord.mjs';
import { potTransport } from './launch-pots.mjs';
import { herdrRunner } from './launch-runner.mjs';
import { launchService } from './launch-service.mjs';
import { keychainToken, loadSettings, STATE_HOME } from './launch-settings.mjs';
import { gateStore, readPrivate } from './launch-store.mjs';

const POLL_MS = 5000;
const warn = message => process.stderr.write(`${message}\n`);
const COMMAND_MS = 10_000;

export async function check() {
  const config = loadSettings();
  console.log('Private settings: valid.');
  const client = discordClient(keychainToken());
  await client.check(config);
  console.log('Discord bot, intent, channel and operator membership: valid.');
  for (const tool of ['node', 'pi', 'hc']) {
    await commandOutput(tool, ['--version'], { timeout: COMMAND_MS });
    console.log(`${tool}: available.`);
  }
  const pots = potTransport();
  for (const pot of config.pots) {
    await pots.reach(pot);
    console.log(`Herdr reaches ${pot}.`);
  }
}

// A crashed gate's PID is given to another process later, so the lock names its owner by start time too.
function processStart(pid) {
  try { return command('ps', ['-o', 'lstart=', '-p', `${pid}`]); } catch { return undefined; }
}

export function lockService(folder) {
  const path = join(folder, 'service.lock');
  if (existsSync(path)) {
    const previous = readPrivate(path);
    const started = processStart(previous.pid);
    if (started && started === previous.started) throw new Error('mac-launch: a gate is already running.');
    rmSync(path);
  }
  const owner = { pid: process.pid, started: processStart(process.pid) };
  writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  const release = () => {
    if (existsSync(path) && readPrivate(path).pid === owner.pid) rmSync(path);
  };
  process.on('exit', release);
  return release;
}

async function history(client, service, config, applicationId) {
  let before;
  for (;;) {
    const messages = await client.history(config.channelId, before);
    if (!messages.length) return;
    const recent = messages.filter(message => Date.now() - Date.parse(message.timestamp) < LAUNCH_TTL_MS);
    for (const message of recent.reverse()) {
      try { await service.notice({ ...message, guild_id: config.guildId }, applicationId); }
      catch { warn('mac-launch: a historical notice was refused.'); }
    }
    if (recent.length !== messages.length || messages.length < 100) return;
    before = messages.at(-1).id;
  }
}

export async function serve() {
  const config = loadSettings();
  checkDiscordPolicy(LAUNCH_POLICY, config.humanDiscord);
  const store = gateStore(STATE_HOME);
  const release = lockService(STATE_HOME);
  const client = discordClient(keychainToken());
  const service = launchService({ store, discord: client, pots: potTransport(), runner: herdrRunner(store), settings: loadSettings, warn });
  let applicationId;
  let pending = Promise.resolve();
  const enqueue = operation => { pending = pending.then(operation).catch(() => warn('mac-launch: event refused or unavailable. No approval was inferred.')); };
  const close = client.listen((kind, event) => {
    if (kind === 'READY') {
      applicationId = event.application.id;
      enqueue(() => history(client, service, loadSettings(), applicationId));
    }
    if (kind === 'MESSAGE_CREATE' && applicationId) enqueue(() => service.notice(event, applicationId));
    if (kind === 'INTERACTION_CREATE' && applicationId) enqueue(() => service.press(event));
  }, error => { warn(error.message); stop(); process.exitCode = 1; });
  const timer = setInterval(() => enqueue(async () => {
    try { checkDiscordPolicy(LAUNCH_POLICY, loadSettings().humanDiscord); }
    catch (error) { warn(error.message); stop(); process.exitCode = 1; return; }
    await service.tick();
  }), POLL_MS);
  function stop() { clearInterval(timer); close(); release(); }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
