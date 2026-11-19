import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    repository TEXT NOT NULL, number INTEGER NOT NULL, subject TEXT NOT NULL,
    current INTEGER NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
    runner INTEGER, result TEXT, reported INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS current_pull ON jobs(repository, number) WHERE current = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS live_pull ON jobs(repository, number) WHERE status IN ('running', 'uncertain');
  CREATE TABLE IF NOT EXISTS containers (job INTEGER PRIMARY KEY, name TEXT NOT NULL, docker_id TEXT);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, job INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wake (slot INTEGER PRIMARY KEY CHECK (slot = 1), revision INTEGER NOT NULL, consumed INTEGER NOT NULL);
  INSERT OR IGNORE INTO wake VALUES (1, 0, 0);
`;
// A PR whose runner is live or whose last runner could not be proven gone starts no other runner.
const NO_LIVE_RUNNER = `NOT EXISTS (SELECT 1 FROM jobs live WHERE live.repository = jobs.repository
  AND live.number = jobs.number AND live.status IN ('running', 'uncertain'))`;
const STATEMENTS = {
  get: 'SELECT * FROM jobs WHERE id = ?',
  current: 'SELECT * FROM jobs WHERE repository = ? AND number = ? AND current = 1',
  supersede: `UPDATE jobs SET current = 0, status = CASE WHEN status = 'queued' THEN 'superseded' ELSE status END WHERE id = ?`,
  hand: 'UPDATE jobs SET current = 0, reported = 1 WHERE id = ?',
  add: `INSERT INTO jobs(repository, number, subject, current, status, attempt) VALUES (?, ?, ?, 1, 'queued', ?) RETURNING *`,
  claim: `UPDATE jobs SET status = 'running', runner = ? WHERE id = ? AND current = 1 AND status = 'queued' AND ${NO_LIVE_RUNNER}`,
  finish: `UPDATE jobs SET status = ?, result = ? WHERE id = ? AND status = 'running'`,
  interrupt: `UPDATE jobs SET status = 'interrupted', result = ? WHERE id = ? AND status IN ('running', 'uncertain')`,
  append: 'INSERT INTO events(job, type, detail) VALUES (?, ?, ?)',
  pending: `SELECT * FROM jobs WHERE status = 'running' OR (reported = 0 AND status IN ('complete', 'uncertain', 'interrupted'))
    OR (current = 1 AND status = 'queued' AND ${NO_LIVE_RUNNER}) ORDER BY id`,
  reserveContainer: 'INSERT INTO containers(job, name) VALUES (?, ?)',
  identifyContainer: 'UPDATE containers SET docker_id = ? WHERE job = ?',
  container: 'SELECT name, docker_id AS dockerId FROM containers WHERE job = ?',
  clearContainer: 'DELETE FROM containers WHERE job = ?',
  events: 'SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?',
  reported: 'UPDATE jobs SET reported = 1 WHERE id = ?',
  wake: 'UPDATE wake SET revision = revision + 1',
  pendingWake: 'SELECT revision FROM wake WHERE revision > consumed',
  consumeWake: 'UPDATE wake SET consumed = max(consumed, ?)',
};
const MAX_ATTEMPTS = 2;
const RETRYABLE_STAGES = new Set(['superseded', 'checks-missing']);

function canRetryObservation(row) {
  return row.status === 'complete' && RETRYABLE_STAGES.has(JSON.parse(row.result).stage);
}
export const CHANGE_FILE = 'changed';
const EVENT_BATCH = 100;
const BUSY_TIMEOUT_MS = 5000;

function job(row) {
  if (!row) return undefined;
  const { id, status, attempt, runner } = row;
  return { id, subject: JSON.parse(row.subject), isCurrent: row.current === 1, status, attempt, runner, result: JSON.parse(row.result) };
}

// One SQLite file holds every generation, its events and the pending wake, so a new controller, runner or stream reader resumes from what was committed.
export class FactoryJobs {
  #database;
  #sql;
  #changed;

  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#changed = join(directory, CHANGE_FILE);
    this.#database = new DatabaseSync(join(directory, 'jobs.sqlite'), { timeout: BUSY_TIMEOUT_MS });
    this.#database.exec(SCHEMA);
    this.#sql = Object.fromEntries(Object.entries(STATEMENTS).map(([name, text]) => [name, this.#database.prepare(text)]));
  }

  #transaction(operation) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #notify() {
    try {
      writeFileSync(this.#changed, String(process.pid), { mode: 0o600 });
    } catch {
      process.stderr.write('factory: state committed but change notification failed\n');
    }
  }

  #append(id, type, detail) {
    this.#sql.append.run(id, type, JSON.stringify(detail));
  }

  #queue(subject, attempt) {
    const row = this.#sql.add.get(subject.repository, subject.number, JSON.stringify(subject), attempt);
    this.#append(row.id, 'queued', subject);
    return job(row);
  }

  observe(subject) {
    let isNew = false;
    const current = this.#transaction(() => {
      const prior = this.#sql.current.get(subject.repository, subject.number);
      if (prior?.subject === JSON.stringify(subject) && !canRetryObservation(prior)) return job(prior);
      if (prior) {
        this.#sql.supersede.run(prior.id);
        this.#append(prior.id, 'superseded', {});
      }
      isNew = true;
      return this.#queue(subject, 1);
    });
    if (isNew) this.#notify();
    return current;
  }

  current({ repository, number }) {
    return this.#sql.current.get(repository, number)?.id;
  }

  get(id) {
    return job(this.#sql.get.get(id));
  }

  claim(id) {
    const isClaimed = this.#transaction(() => {
      const runner = process.pid;
      if (this.#sql.claim.run(runner, id).changes === 0) return false;
      this.#append(id, 'running', { runner });
      return true;
    });
    if (isClaimed) this.#notify();
    return isClaimed;
  }

  progress(id, type, detail) {
    this.#append(id, type, detail);
    this.#notify();
  }

  finish(id, status, result) {
    const isFinished = this.#transaction(() => {
      if (this.#sql.finish.run(status, JSON.stringify(result), id).changes === 0) return false;
      this.#append(id, status, result);
      return true;
    });
    if (isFinished) this.#notify();
    return isFinished;
  }

  // Only a runner proven gone with its processes and containers comes here: the successor generation reruns the same subject from the start.
  retry(id, reason) {
    const successor = this.#transaction(() => {
      const prior = this.#sql.get.get(id);
      if (this.#sql.interrupt.run(JSON.stringify({ reason }), id).changes === 0) return undefined;
      this.#append(id, 'interrupted', { reason });
      if (prior.current !== 1 || prior.attempt >= MAX_ATTEMPTS) return undefined;
      this.#sql.hand.run(id);
      return this.#queue(JSON.parse(prior.subject), prior.attempt + 1);
    });
    this.#notify();
    return successor;
  }

  reserveContainer(id, name) {
    this.#sql.reserveContainer.run(id, name);
  }

  identifyContainer(id, dockerId) {
    this.#sql.identifyContainer.run(dockerId, id);
  }

  container(id) {
    return this.#sql.container.get(id);
  }

  clearContainer(id) {
    this.#sql.clearContainer.run(id);
  }

  pending() {
    return this.#sql.pending.all().map(job);
  }

  markReported(id) {
    this.#sql.reported.run(id);
  }

  events(after) {
    return this.#sql.events.all(after, EVENT_BATCH).map(event => ({ ...event, detail: JSON.parse(event.detail) }));
  }

  wake() {
    this.#sql.wake.run();
    this.#notify();
  }

  pendingWake() {
    return this.#sql.pendingWake.get()?.revision;
  }

  consumeWake(revision) {
    this.#sql.consumeWake.run(revision);
  }

  close() {
    this.#database.close();
  }
}

export const openJobs = directory => new FactoryJobs(directory);
