import { CLOCK_SKEW_MS } from '../session/launch-contract.mjs';

const API = 'https://discord.com/api/v10';
const REQUEST_MS = 10_000;
const RECONNECT_MS = 5000;
const FATAL_CLOSES = [4004, 4010, 4011, 4012, 4013, 4014];
const INTENTS = 1 | 512 | 32768;
const BOT_FLAG_CONTENT = (1 << 18) | (1 << 19);
const PRIVATE_REPLY = 1 << 6;
const GATEWAY_OPCODE = { dispatch: 0, heartbeat: 1, reconnect: 7, invalidSession: 9, hello: 10, heartbeatAck: 11 };

function requestHeaders(token, body) {
  const authorization = { Authorization: `Bot ${token}` };
  if (body instanceof FormData) return authorization;
  return { ...authorization, 'Content-Type': 'application/json' };
}

function requestBody(body) {
  if (body === undefined || body instanceof FormData) return body;
  return JSON.stringify(body);
}

export function discordClient(token, { fetcher = fetch, connect = url => new WebSocket(url), timers = globalThis } = {}) {
  let serverTime;
  async function api(method, path, body) {
    try {
      const response = await fetcher(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS),
        headers: requestHeaders(token, body), body: requestBody(body) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      serverTime = Date.parse(response.headers?.get('date'));
      return response.status === 204 ? undefined : await response.json();
    } catch {
      throw new Error('mac-launch: Discord rejected or timed out a request. Check the application and channel permissions.');
    }
  }
  const warn = message => process.stderr.write(`${message}\n`);
  async function post(channel, payload, prompt) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([prompt], { type: 'text/plain;charset=utf-8' }), payload.attachments[0].filename);
    return api('POST', `/channels/${channel}/messages`, form);
  }
  const edit = (channel, message, payload) => api('PATCH', `/channels/${channel}/messages/${message}`, payload);
  const acknowledge = event => api('POST', `/interactions/${event.id}/${event.token}/callback`, { type: 6 });
  const tell = (event, content) => api('POST', `/webhooks/${event.application_id}/${event.token}`, { content, flags: PRIVATE_REPLY, allowed_mentions: { parse: [] } });
  function listen(onEvent, onFatal) {
    let socket;
    let heartbeat;
    let reconnect;
    let isStopped = false;
    let sequence = null;
    let isAcknowledged = true;
    const send = payload => socket.send(JSON.stringify(payload));
    const sendHeartbeat = () => {
      isAcknowledged = false;
      send({ op: 1, d: sequence });
    };
    const beat = () => {
      if (!isAcknowledged) { socket.close(); return; }
      sendHeartbeat();
    };
    function open() {
      sequence = null;
      isAcknowledged = true;
      socket = connect('wss://gateway.discord.gg/?v=10&encoding=json');
      socket.addEventListener('message', receive);
      socket.addEventListener('error', () => socket.close());
      socket.addEventListener('close', event => {
        timers.clearInterval(heartbeat);
        if (isStopped) return;
        if (FATAL_CLOSES.includes(event.code)) { isStopped = true; onFatal(new Error(`mac-launch: gateway refused this application (${event.code}).`)); return; }
        reconnect = timers.setTimeout(open, RECONNECT_MS);
      });
    }
    function handleHello(packet) {
      heartbeat = timers.setInterval(beat, packet.d.heartbeat_interval);
      send({ op: 2, d: { token, intents: INTENTS, properties: { os: 'darwin', browser: 'agent-sandbox', device: 'mac-launch' } } });
    }
    const handlers = new Map([
      [GATEWAY_OPCODE.hello, handleHello],
      [GATEWAY_OPCODE.heartbeatAck, () => { isAcknowledged = true; }],
      [GATEWAY_OPCODE.heartbeat, sendHeartbeat],
      [GATEWAY_OPCODE.reconnect, () => socket.close()],
      [GATEWAY_OPCODE.invalidSession, () => socket.close()],
      [GATEWAY_OPCODE.dispatch, packet => onEvent(packet.t, packet.d)],
    ]);
    function receive(event) {
      try {
        const packet = JSON.parse(event.data);
        if (packet.s !== null && packet.s !== undefined) sequence = packet.s;
        handlers.get(packet.op)?.(packet);
      } catch { warn('mac-launch: a gateway event could not be processed.'); }
    }
    open();
    return () => { isStopped = true; timers.clearTimeout(reconnect); timers.clearInterval(heartbeat); socket.close(); };
  }
  function requireBotIdentity(bot, application, channel, settings) {
    if (!bot.bot || !(application.flags & BOT_FLAG_CONTENT) || channel.guild_id !== settings.guildId) {
      throw new Error('mac-launch: bot identity, Message Content intent or launch server does not match.');
    }
  }
  function requireSynchronizedTime() {
    if (!Number.isFinite(serverTime) || Math.abs(Date.now() - serverTime) > CLOCK_SKEW_MS) {
      throw new Error(`mac-launch: this Mac and Discord must agree on time within ${CLOCK_SKEW_MS / 1000} seconds.`);
    }
  }
  async function check(settings) {
    const bot = await api('GET', '/users/@me');
    const application = await api('GET', '/oauth2/applications/@me');
    const channel = await api('GET', `/channels/${settings.channelId}`);
    await api('GET', `/guilds/${settings.guildId}/members/${settings.humanDiscord.userId}`);
    requireBotIdentity(bot, application, channel, settings);
    requireSynchronizedTime();
  }
  const history = (channel, before) => api('GET', `/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ''}`);
  return { post, edit, acknowledge, tell, listen, check, history };
}
