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

function allowsRepository(repository, approved) {
  const name = repository?.full_name;
  return typeof name === 'string' && repository.private === false && approved.has(name.toLowerCase());
}

function isPullNumber(event) {
  return Number.isSafeInteger(event.number) && event.number > 0 && event.pull_request?.number === event.number;
}

function eventRejection(event, approved) {
  if (typeof event?.action !== 'string') return 400;
  return pullRejection(event, approved);
}

function pullRejection(event, approved) {
  if (!ACTIONS.has(event.action)) return 204;
  if (!allowsRepository(event.repository, approved)) return 403;
  if (!isPullNumber(event)) return 400;
}

function expireReceipts(receipts, timestamp) {
  for (const [id, receipt] of receipts) {
    if (!receipt.pending && timestamp >= receipt.expires) receipts.delete(id);
  }
}

async function notify(receipts, delivery, digest, expires, wake) {
  const pending = Promise.resolve().then(wake).then(() => true, () => false);
  const receipt = { digest, pending, expires };
  receipts.set(delivery, receipt);
  if (!await pending) {
    receipts.delete(delivery);
    return 503;
  }
  delete receipt.pending;
  return 202;
}

function receiptQueue(wake, now) {
  const receipts = new Map();
  return async (delivery, bytes) => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const timestamp = now();
    expireReceipts(receipts, timestamp);
    const prior = receipts.get(delivery) ?? [...receipts.values()].find(receipt => receipt.digest === digest);
    if (prior) return duplicateStatus(prior);
    if (receipts.size >= MAX_DELIVERIES) return 503;
    return notify(receipts, delivery, digest, timestamp + RETENTION_MS, wake);
  };
}

async function duplicateStatus(receipt) {
  return (await receipt.pending) === false ? 503 : 204;
}

function authenticateDelivery(headers, bytes, key) {
  if (!authenticated(key, bytes, headers['x-hub-signature-256'])) return 401;
  if (headers['x-github-event'] !== 'pull_request') return 204;
  return deliveryIdentifier(headers['x-github-delivery']);
}

function deliveryIdentifier(delivery = '') {
  return DELIVERY_ID.test(delivery) ? delivery.toLowerCase() : 400;
}

export function factoryReceipt({ key, repositories, wake, now = Date.now }) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('factory webhook: expected a 64-character hexadecimal key');
  const approved = new Set(repositories);
  if (approved.size === 0 || [...approved].some(repository => !REPOSITORY.test(repository))) {
    throw new Error('factory webhook: expected a list of approved lowercase repositories');
  }
  const queue = receiptQueue(wake, now);
  return async (headers, bytes) => {
    const delivery = authenticateDelivery(headers, bytes, key);
    if (typeof delivery === 'number') return delivery;
    return eventRejection(payload(bytes), approved) ?? queue(delivery, bytes);
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

function routeMatches(incoming, host) {
  return incoming.method === 'POST' && incoming.url === ROUTE && incoming.headers.host === host;
}

export function createFactoryReceiver({ host, ...options }) {
  const receive = factoryReceipt(options);
  const server = createServer({ maxHeaderSize: 8192 }, (incoming, response) => {
    clearTimeout(HEADER_TIMERS.get(incoming.socket));
    response.setHeader('Connection', 'close');
    if (!routeMatches(incoming, host)) return response.writeHead(404).end();
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

function isPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function listenerConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!config.host || !isPort(config.port) || !config.wakeSocket?.startsWith('/')) throw new Error('factory webhook: invalid listener configuration');
  return config;
}

main(import.meta, () => {
  const [configuration] = process.argv.slice(2);
  if (!configuration) throw new Error('usage: factory-webhook.mjs CONFIGURATION_JSON (key on descriptor 3)');
  const { host, port, repositories, wakeSocket } = listenerConfig(configuration);
  const key = readFileSync(3, 'utf8').trim();
  createFactoryReceiver({ host, repositories, key, wake: () => signalFactory(wakeSocket) }).listen(port, '127.0.0.1');
});
