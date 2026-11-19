const HEARTBEAT_MS = 15_000;

export function streamFactoryEvents(request, response, jobs, subscribers) {
  const last = request.headers['last-event-id'] ?? '0';
  let cursor = Number(last);
  if (request.method !== 'GET' || request.url !== '/events' || !/^\d+$/.test(last) || !Number.isSafeInteger(cursor)) {
    response.writeHead(400).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  response.flushHeaders();
  let nextBatch;
  function replay() {
    if (response.writableNeedDrain || response.destroyed) return;
    clearImmediate(nextBatch);
    try {
      const events = jobs.events(cursor);
      for (const event of events) {
        cursor = event.id;
        if (!response.write(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) return;
      }
      if (events.length) nextBatch = setImmediate(replay);
    } catch {
      response.destroy();
    }
  }
  const heartbeat = setInterval(() => {
    if (!response.writableNeedDrain) response.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  subscribers.add(replay);
  response.on('drain', replay);
  response.once('close', () => {
    subscribers.delete(replay);
    clearInterval(heartbeat);
    clearImmediate(nextBatch);
  });
  replay();
}
