const HEARTBEAT_MS = 15_000;

function eventCursor(request) {
  if (request.method !== 'GET' || request.url !== '/events') return undefined;
  return parseCursor(request.headers['last-event-id'] ?? '0');
}

function parseCursor(last) {
  const cursor = Number(last);
  if (/^\d+$/.test(last) && Number.isSafeInteger(cursor)) return cursor;
}

function sendEvents(response, jobs, initialCursor) {
  let cursor = initialCursor;
  let nextBatch;
  const stop = () => clearImmediate(nextBatch);
  function replay() {
    if (response.writableNeedDrain || response.destroyed) return;
    stop();
    try {
      sendBatch();
    } catch {
      response.destroy();
    }
  }
  function sendBatch() {
    const events = jobs.events(cursor);
    for (const event of events) {
      cursor = event.id;
      if (!response.write(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) return;
    }
    if (events.length) nextBatch = setImmediate(replay);
  }
  return { replay, stop };
}

export function streamFactoryEvents(request, response, jobs, subscribers) {
  const cursor = eventCursor(request);
  if (cursor === undefined) return response.writeHead(400).end();
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const { replay, stop } = sendEvents(response, jobs, cursor);
  const heartbeat = setInterval(() => {
    if (!response.writableNeedDrain) response.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  subscribers.add(replay);
  response.on('drain', replay);
  response.once('close', () => {
    subscribers.delete(replay);
    clearInterval(heartbeat);
    stop();
  });
  response.flushHeaders();
  replay();
}
