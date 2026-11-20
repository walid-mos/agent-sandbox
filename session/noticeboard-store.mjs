import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NOTICEBOARD_LIMITS, routeFor } from './noticeboard-policy.mjs';

const KEY = /^[a-f0-9]{64}$/;
const LOCK_DESCRIPTOR = 3;
const SCHEMA = `PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK(id = 1), cursor INTEGER NOT NULL);
  INSERT OR IGNORE INTO progress VALUES (1, 0);`;

function privateFile(path) {
  if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || metadata.mode & 0o077) {
    throw new Error('noticeboards: storage must be an owned private regular file.');
  }
}

function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077) {
    throw new Error('noticeboards: storage directory must be owned and private.');
  }
  privateFile(path);
  privateFile(`${path}.lock`);
  const database = new DatabaseSync(path);
  database.exec(SCHEMA);
  return database;
}

function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function requireCapacity(database) {
  const records = database.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM records').get();
  const events = database.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM inbox').get();
  if (records.count > NOTICEBOARD_LIMITS.records || events.count > NOTICEBOARD_LIMITS.records || records.bytes + events.bytes > NOTICEBOARD_LIMITS.bytes) {
    throw new Error('noticeboards: storage capacity reached. Preserve existing work and stop intake.');
  }
}

function enqueue(database, events) {
  if (!Array.isArray(events) || events.length > NOTICEBOARD_LIMITS.batch) throw new Error('noticeboards: inbox batch exceeds its bound.');
  transaction(database, () => {
    let cursor = database.prepare('SELECT cursor FROM progress').get().cursor;
    for (const event of [...events].sort((left, right) => left.id - right.id)) {
      routeFor(event, { channels: [] });
      if (event.id <= cursor) continue;
      const { id, channelId, messageId, kind } = event;
      database.prepare('INSERT INTO inbox VALUES (?, ?)').run(id, JSON.stringify({ id, channelId, messageId, kind }));
      cursor = id;
    }
    database.prepare('UPDATE progress SET cursor = ?').run(cursor);
    requireCapacity(database);
  });
}

function prune(database, now) {
  const expired = database.prepare("SELECT body FROM records WHERE json_extract(body, '$.stage') = 'verified' AND json_extract(body, '$.verifiedAt') < ?").all(now - NOTICEBOARD_LIMITS.retentionMs);
  transaction(database, () => {
    for (const { body } of expired) {
      const { snapshot, archive, ...record } = JSON.parse(body);
      database.prepare('UPDATE records SET body = ? WHERE key = ?').run(JSON.stringify({ ...record, stage: 'retained' }), record.key);
    }
  });
}

function defer(database, id, now, retry) {
  const row = database.prepare('SELECT body FROM inbox WHERE id = ?').get(id);
  if (!row) return;
  const event = JSON.parse(row.body);
  const attempts = retry?.attempts === NOTICEBOARD_LIMITS.attempts ? NOTICEBOARD_LIMITS.attempts : (event.attempts ?? 0) + 1;
  const retryAt = Math.max(retry?.retryAt ?? now, now + NOTICEBOARD_LIMITS.retryMs * 2 ** (attempts - 1));
  database.prepare('UPDATE inbox SET body = ? WHERE id = ?').run(JSON.stringify({ ...event, attempts, retryAt }), id);
}

export function noticeboardStore(path) {
  const database = openDatabase(path);
  let isBusy = false;
  const get = key => {
    const row = database.prepare('SELECT body FROM records WHERE key = ?').get(key);
    return row ? JSON.parse(row.body) : undefined;
  };
  async function exclusive(operation) {
    if (isBusy) return { status: 'busy' };
    isBusy = true;
    const descriptor = openSync(`${path}.lock`, 'a', 0o600);
    try {
      const lock = spawnSync('flock', ['-n', `${LOCK_DESCRIPTOR}`], { stdio: ['ignore', 'ignore', 'ignore', descriptor] });
      if (lock.error || lock.status !== 0) return { status: 'busy' };
      return await operation();
    } finally {
      closeSync(descriptor);
      isBusy = false;
    }
  }
  const put = record => transaction(database, () => {
    if (!KEY.test(record.key)) throw new Error('noticeboards: invalid archive identity.');
    database.prepare('INSERT INTO records VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body').run(record.key, JSON.stringify(record));
    requireCapacity(database);
  });
  return { get, put, exclusive,
    records: () => database.prepare('SELECT body FROM records ORDER BY key').all().map(row => JSON.parse(row.body)),
    enqueue: events => enqueue(database, events),
    events: () => database.prepare('SELECT body FROM inbox ORDER BY id LIMIT ?').all(NOTICEBOARD_LIMITS.batch).map(row => JSON.parse(row.body)),
    pendingEvents: now => database.prepare("SELECT body FROM inbox WHERE coalesce(json_extract(body, '$.attempts'), 0) < ? AND coalesce(json_extract(body, '$.retryAt'), 0) <= ? ORDER BY id LIMIT ?").all(NOTICEBOARD_LIMITS.attempts, now, NOTICEBOARD_LIMITS.batch).map(row => JSON.parse(row.body)),
    cursor: () => database.prepare('SELECT cursor FROM progress').get().cursor,
    complete: id => database.prepare('DELETE FROM inbox WHERE id = ?').run(id),
    defer: (id, now, retry) => defer(database, id, now, retry),
    prune: now => prune(database, now), close: () => database.close() };
}
