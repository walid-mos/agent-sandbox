import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { main } from './main.mjs';

const ROUTE = '/github/factory';
const MAX_BODY = 1024 * 1024;
const READ_MS = 2000;
const MAX_DELIVERIES = 4096;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const HEADER_TIMERS = new WeakMap();
const DELIVERY_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[a-z0-9-]+\/[a-z0-9_.-]+$/;
const ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'converted_to_draft', 'synchronize', 'edited', 'closed']);

function authenticated(key, bytes, signature) {
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', key).update(bytes).digest(), Buffer.from(signature.slice(7), 'hex'));
}

function payload(bytes) {
  try {
    return JSON.parse(bytes);
  } catch {
    return undefined;
  }
}

export function factoryReceipt({ key, repositories, wake, now = Date.now }) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('factory webhook: expected a 64-character hexadecimal key');
  const approved = new Set(repositories);
  if (approved.size === 0 || [...approved].some(repository => !REPOSITORY.test(repository))) {
    throw new Error('factory webhook: expected a list of approved lowercase repositories');
  }
  const receipts = new Map();
  return async (headers, bytes) => {
    if (!authenticated(key, bytes, headers['x-hub-signature-256'])) return 401;
    if (headers['x-github-event'] !== 'pull_request') return 204;
    const event = payload(bytes);
    if (!event || typeof event.action !== 'string') return 400;
    if (!ACTIONS.has(event.action)) return 204;
    const repository = event.repository?.full_name;
    if (typeof repository !== 'string' || event.repository.private !== false || !approved.has(repository.toLowerCase())) return 403;
    const delivery = headers['x-github-delivery'];
    if (typeof delivery !== 'string' || !DELIVERY_ID.test(delivery) || !Number.isSafeInteger(event.number)
      || event.number < 1 || event.pull_request?.number !== event.number) return 400;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const timestamp = now();
    for (const [id, receipt] of receipts) {
      if (!receipt.pending && timestamp >= receipt.expires) receipts.delete(id);
    }
    const prior = receipts.get(delivery) ?? [...receipts.values()].find(receipt => receipt.digest === digest);
    if (prior) return await prior.pending === false ? 503 : 204;
    if (receipts.size >= MAX_DELIVERIES) return 503;
    const pending = Promise.resolve().then(wake).then(() => true, () => false);
    const receipt = { digest, pending, expires: timestamp + RETENTION_MS };
    receipts.set(delivery, receipt);
    if (!await pending) {
      receipts.delete(delivery);
      return 503;
    }
    delete receipt.pending;
    return 202;
  };
}

function receiveBody(incoming, response, receive) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => incoming.destroy(), READ_MS);
  incoming.once('close', () => clearTimeout(timer));
  incoming.on('error', () => response.destroy());
  incoming.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) incoming.destroy();
    else chunks.push(chunk);
  });
  incoming.on('end', async () => {
    clearTimeout(timer);
    if (size > MAX_BODY) return;
    try {
      response.writeHead(await receive(incoming.headers, Buffer.concat(chunks))).end();
    } catch {
      response.writeHead(503).end();
    }
  });
}

export function createFactoryReceiver({ host, ...options }) {
  const receive = factoryReceipt(options);
  const server = createServer({ maxHeaderSize: 8192 }, (incoming, response) => {
    clearTimeout(HEADER_TIMERS.get(incoming.socket));
    response.setHeader('Connection', 'close');
    if (incoming.method !== 'POST' || incoming.url !== ROUTE || incoming.headers.host !== host) return response.writeHead(404).end();
    if (incoming.headers['content-encoding']) return response.writeHead(415).end();
    if (Number(incoming.headers['content-length']) > MAX_BODY) return response.writeHead(413).end();
    receiveBody(incoming, response, receive);
  });
  server.on('connection', socket => {
    const timer = setTimeout(() => socket.destroy(), READ_MS);
    HEADER_TIMERS.set(socket, timer);
    socket.once('close', () => clearTimeout(timer));
  });
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  return server;
}

export function signalFactory(socketPath) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: '/wake', method: 'POST', headers: { 'Content-Length': 0 } }, response => {
      response.resume();
      if (response.statusCode === 204) resolve();
      else reject(new Error('factory wake unavailable'));
    });
    outgoing.setTimeout(READ_MS, () => outgoing.destroy(new Error('factory wake timed out')));
    outgoing.once('error', reject);
    outgoing.end();
  });
}

main(import.meta, () => {
  const [configuration] = process.argv.slice(2);
  if (!configuration) throw new Error('usage: factory-webhook.mjs CONFIGURATION_JSON (key on descriptor 3)');
  const { host, port, repositories, wakeSocket } = JSON.parse(readFileSync(configuration, 'utf8'));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !wakeSocket?.startsWith('/')) throw new Error('factory webhook: invalid listener configuration');
  const key = readFileSync(3, 'utf8').trim();
  createFactoryReceiver({ host, repositories, key, wake: () => signalFactory(wakeSocket) }).listen(port, '127.0.0.1');
});
