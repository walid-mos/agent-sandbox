import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isServerLogEvent, isServerLogTimestamp, serverLogEvent, SERVER_LOG_EVENT } from './server-log-events.mjs';

export const SOURCE_REFRESH_CAPACITY = 128;
const WARNING = SERVER_LOG_EVENT.sourceRefreshFailed;
const DATABASE_BUSY_TIMEOUT_MS = 250;
const SCHEMA = `PRAGMA synchronous = EXTRA;
  CREATE TABLE IF NOT EXISTS incidents (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    failed_at TEXT NOT NULL,
    recovered_at TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS active_incident ON incidents ((1)) WHERE recovered_at IS NULL;`;

function isPrivate(metadata) {
  return metadata.uid === process.getuid() && !(metadata.mode & 0o077);
}

function preparePrivateFile(path) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || !isPrivate(directory)) throw new Error('server-log: incident directory must be owned and private.');
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const file = lstatSync(path);
  if (!file.isFile() || !isPrivate(file)) throw new Error('server-log: incident database must be an owned private regular file.');
}

function openDatabase(path) {
  preparePrivateFile(path);
  const database = new DatabaseSync(path, { timeout: DATABASE_BUSY_TIMEOUT_MS });
  try {
    database.exec(SCHEMA);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function snapshot({ id, failed_at: at, recovered_at: recoveredAt }) {
  return { warning: { id, kind: WARNING, at }, recoveredAt };
}

function acknowledge(database, incident) {
  const { warning, recoveredAt } = incident ?? {};
  if (!isServerLogEvent(warning) || warning.kind !== WARNING || (recoveredAt !== null && !isServerLogTimestamp(recoveredAt))) {
    throw new Error('server-log: acknowledge a provisioning incident snapshot returned by the collector read.');
  }
  const claim = 'WHERE id = ? AND failed_at = ? AND recovered_at IS ? AND acknowledged = 0';
  const statement = recoveredAt === null ? 'UPDATE incidents SET acknowledged = 1' : 'DELETE FROM incidents';
  return database.prepare(`${statement} ${claim}`).run(warning.id, warning.at, recoveredAt).changes === 1;
}

function refreshState(database) {
  return database.prepare(`SELECT count(*) AS count,
    EXISTS (SELECT 1 FROM incidents WHERE recovered_at IS NULL) AS active FROM incidents`).get();
}

function insertFailure(database, now) {
  const { count, active } = refreshState(database);
  if (active) return;
  if (count >= SOURCE_REFRESH_CAPACITY) throw new Error('server-log: incident capacity reached. Retain existing records until collection.');
  const { id, at } = serverLogEvent(WARNING, now);
  database.prepare('INSERT INTO incidents (id, failed_at) VALUES (?, ?)').run(id, at);
}

function recordFailure(database, now) {
  database.exec('BEGIN IMMEDIATE');
  try {
    insertFailure(database, now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function sourceRefreshIncidents(path) {
  const database = openDatabase(path);
  return {
    canRefresh() {
      const { count, active } = refreshState(database);
      return active === 1 || count < SOURCE_REFRESH_CAPACITY;
    },
    recordFailure: now => recordFailure(database, now),
    recordRecovery: now => database.prepare('UPDATE incidents SET recovered_at = ?, acknowledged = 0 WHERE recovered_at IS NULL').run(now.toISOString()),
    readPending: () => database.prepare('SELECT id, failed_at, recovered_at FROM incidents WHERE acknowledged = 0 ORDER BY sequence').all().map(snapshot),
    acknowledge: incident => acknowledge(database, incident),
    close: () => database.close(),
  };
}
