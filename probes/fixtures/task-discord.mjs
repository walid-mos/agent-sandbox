import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

export async function discordApiFixture(t, owner) {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"id":"synthetic-discord-message"}');
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  owner({ kind: 'simulated-discord-api', endpoint });
  async function report(task) {
    const response = await fetch(`${endpoint}/channels/synthetic/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: `Task ${task.id}: ${task.acceptance.state}`, task }),
    });
    assert.equal(response.status, 200);
  }
  return { report, received };
}
