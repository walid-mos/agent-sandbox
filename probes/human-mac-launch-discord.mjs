import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordClient } from '../mac/launch-discord.mjs';

function gateway() {
  const sockets = [];
  const intervals = new Map();
  const timeouts = new Map();
  let next = 0;
  const timers = { setInterval: callback => { const id = ++next; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id), setTimeout: callback => { const id = ++next; timeouts.set(id, callback); return id; }, clearTimeout: id => timeouts.delete(id) };
  const connect = url => {
    assert.equal(url, 'wss://gateway.discord.gg/?v=10&encoding=json');
    const listeners = new Map();
    const socket = { sent: [], addEventListener: (kind, callback) => listeners.set(kind, callback),
      send: text => socket.sent.push(JSON.parse(text)), close: () => listeners.get('close')({ code: 1006 }),
      receive: packet => listeners.get('message')({ data: JSON.stringify(packet) }), end: code => listeners.get('close')({ code }) };
    sockets.push(socket);
    return socket;
  };
  return { sockets, intervals, timeouts, timers, connect };
}

test('gateway identifies on each connection and never resumes a missed approval', () => {
  const g = gateway();
  const events = [];
  const close = discordClient('test-only', g).listen((...event) => events.push(event), error => { throw error; });
  const first = g.sockets[0];
  first.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  assert.equal(first.sent[0].op, 2);
  first.receive({ op: 0, s: 14, t: 'READY', d: { application: { id: 'test-application' } } });
  assert.equal(events[0][0], 'READY');
  [...g.intervals.values()][0]();
  assert.deepEqual(first.sent.at(-1), { op: 1, d: 14 });
  first.receive({ op: 11 });
  first.receive({ op: 7 });
  assert.equal(g.intervals.size, 0);
  [...g.timeouts.values()][0]();
  const second = g.sockets[1];
  second.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  assert.equal(second.sent[0].op, 2);
  assert.equal(second.sent.some(packet => packet.op === 6), false);
  close();
  assert.equal(g.intervals.size, 0);
});

test('missing heartbeat acknowledgements reconnect and a refused token stops', () => {
  const g = gateway();
  const errors = [];
  const close = discordClient('test-only', g).listen(() => {}, error => errors.push(error));
  g.sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  const beat = [...g.intervals.values()][0];
  beat();
  beat();
  assert.equal(g.timeouts.size, 1);
  [...g.timeouts.values()][0]();
  g.timeouts.clear();
  g.sockets[1].end(4004);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /4004/);
  assert.equal(g.timeouts.size, 0);
  close();
});

test('a server heartbeat request is answered while an earlier heartbeat awaits acknowledgement', () => {
  const g = gateway();
  const close = discordClient('test-only', g).listen(() => {}, error => { throw error; });
  const socket = g.sockets[0];
  socket.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  [...g.intervals.values()][0]();
  const sent = socket.sent.length;
  socket.receive({ op: 1 });
  assert.equal(g.timeouts.size, 0);
  assert.equal(socket.sent.length, sent + 1);
  assert.deepEqual(socket.sent.at(-1), { op: 1, d: null });
  close();
});

test('the Discord adapter uploads the exact prompt and never returns provider error bodies', async () => {
  const captured = [];
  const fetcher = async (url, options) => { captured.push({ url, options }); return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 'message' }) }; };
  const client = discordClient('test-only', { fetcher });
  await client.post('channel', { attachments: [{ filename: 'prompt.txt' }], allowed_mentions: { parse: [] } }, 'Literal $() and `code`\n');
  const form = captured[0].options.body;
  assert.equal(await form.get('files[0]').text(), 'Literal $() and `code`\n');
  assert.deepEqual(JSON.parse(form.get('payload_json')).allowed_mentions, { parse: [] });
  const broken = discordClient('test-only', { fetcher: async () => { throw new Error('sensitive response'); } });
  await assert.rejects(broken.history('channel'), error => !error.message.includes('sensitive response'));
});
