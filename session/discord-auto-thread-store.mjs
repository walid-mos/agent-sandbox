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

export function autoThreadInbox(path, account) {
  const { dev, ino } = statSync(path, { bigint: true });
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const query = database.prepare(MESSAGE_ROWS);
    const latest = database.prepare('SELECT coalesce(max(id), 0) AS id FROM gw_events');
    return { identity: `${dev}:${ino}:${account}`, latest: () => latest.get().id,
      after: cursor => query.all(cursor, account, READ_LIMIT), close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function autoThreadState(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, 'a', 0o600));
  const database = new DatabaseSync(path, { timeout: 5000 });
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL, cursor INTEGER NOT NULL, since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (message_id TEXT PRIMARY KEY NOT NULL);`);
    const progress = database.prepare('SELECT scope, cursor, since FROM progress WHERE id = 1');
    const save = database.prepare('INSERT OR REPLACE INTO progress (id, scope, cursor, since) VALUES (1, ?, ?, ?)');
    const claim = database.prepare('INSERT OR IGNORE INTO claims (message_id) VALUES (?)');
    return { progress: () => progress.get(), save: entry => save.run(entry.scope, entry.cursor, entry.since),
      disable: () => database.exec('DELETE FROM progress'), claim: id => claim.run(id).changes === 1, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
