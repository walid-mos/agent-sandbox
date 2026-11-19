import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const READ_LIMIT = 25;
const MESSAGE_ROWS = `SELECT id, thread, json_object(
  'id', json_extract(raw, '$.id'), 'channel_id', json_extract(raw, '$.channel_id'),
  'guild_id', json_extract(raw, '$.guild_id'), 'timestamp', json_extract(raw, '$.timestamp'),
  'type', json_extract(raw, '$.type'), 'flags', json_extract(raw, '$.flags'),
  'author', json_object('id', json_extract(raw, '$.author.id'), 'bot', json(raw -> '$.author.bot')),
  'webhook_id', json_extract(raw, '$.webhook_id'),
  'interaction_metadata', json_extract(raw, '$.interaction_metadata') IS NOT NULL,
  'message_reference', json_extract(raw, '$.message_reference') IS NOT NULL
) AS message FROM gw_events
WHERE id > ? AND channel = ? AND kind = 'message' AND inbox_event GLOB 'MESSAGE_CREATE:*'
  AND json_valid(raw) ORDER BY id LIMIT ?`;

const REQUIRED_COLUMNS = ['id', 'channel', 'inbox_event', 'kind', 'thread', 'raw'];

export class UnsupportedPotsLog extends Error {}

function logIdentity(path) {
  const { dev, ino, birthtimeNs } = statSync(path, { bigint: true });
  return `${dev}:${ino}:${birthtimeNs}`;
}

function eventReader(path, account) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(gw_events)').all().map(column => column.name));
    const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'gw_events'").get();
    if (!REQUIRED_COLUMNS.every(column => columns.has(column)) || !/\bid\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(schema?.sql ?? '')) {
      throw new UnsupportedPotsLog();
    }
    const query = database.prepare(MESSAGE_ROWS);
    const latest = database.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'gw_events'), 0) AS id");
    return { latest: () => latest.get().id, after: cursor => query.all(cursor, account, READ_LIMIT), close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function autoThreadInbox(path, account) {
  let open;
  function close() {
    open?.close();
    open = undefined;
  }
  const identity = () => `${logIdentity(path)}:${account}`;
  function refresh() {
    const current = identity();
    if (open?.identity === current) return open;
    close();
    const reader = eventReader(path, account);
    open = { ...reader, identity: current, isCurrent: () => identity() === current };
    if (open.isCurrent()) return open;
    close();
    throw new Error('Pots replaced the gateway log while the reader was opening.');
  }
  return { refresh, close };
}

export function autoThreadState(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, 'a', 0o600));
  const database = new DatabaseSync(path, { timeout: 5000 });
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL, cursor INTEGER NOT NULL, since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (message_id TEXT PRIMARY KEY NOT NULL);`);
    const progress = database.prepare('SELECT scope, cursor, since FROM progress WHERE id = 1');
    const begin = database.prepare('INSERT OR IGNORE INTO progress (id, scope, cursor, since) VALUES (1, ?, ?, ?)');
    const replace = database.prepare('UPDATE progress SET scope = ?, cursor = ?, since = ? WHERE id = 1 AND scope = ? AND cursor = ? AND since = ?');
    const advance = database.prepare('UPDATE progress SET cursor = ? WHERE id = 1 AND scope = ? AND since = ? AND cursor < ?');
    const claim = database.prepare(`INSERT OR IGNORE INTO claims (message_id) SELECT ? FROM progress
      WHERE id = 1 AND scope = ? AND since = ?`);
    return {
      progress: () => progress.get(),
      reset: ({ scope, cursor, since }, previous) => previous
        ? replace.run(scope, cursor, since, previous.scope, previous.cursor, previous.since).changes === 1
        : begin.run(scope, cursor, since).changes === 1,
      advance: ({ scope, since }, cursor) => advance.run(cursor, scope, since, cursor),
      claim: ({ scope, since }, id) => claim.run(id, scope, since).changes === 1,
      disable: () => database.exec('DELETE FROM progress'),
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
