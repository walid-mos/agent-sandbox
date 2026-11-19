import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { autoThreadInbox } from '../session/discord-auto-thread-store.mjs';

const SUPPORTED_VERSION = 'pots v0.8.5';
const COMMAND_TIMEOUT_MS = 5000;
const account = 'discord-fixture';
const message = {
  id: '100000000000000001', channel_id: '100000000000000002', guild_id: '100000000000000003',
  timestamp: '2026-11-19T10:00:00.000Z', type: 0, flags: 0,
  author: { id: '100000000000000004', bot: false }, content: 'synthetic message',
};

function installedSchema(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const table = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'gw_events'").get();
    assert.ok(table?.sql, 'Installed Pots log must contain gw_events');
    return table.sql;
  } finally {
    database.close();
  }
}

function seed(path, schema) {
  const database = new DatabaseSync(path);
  try {
    database.exec(schema);
    const insert = database.prepare('INSERT INTO gw_events (channel, inbox_event, kind, at, thread, raw) VALUES (?, ?, ?, ?, ?, ?)');
    const rows = [
      [account, 'MESSAGE_CREATE:fixture-session:1', 'message', null],
      [account, 'MESSAGE_CREATE:fixture-session:2', 'message', 'discord:fixture-thread'],
      [account, `history:${message.id}:`, 'message', null],
      [account, 'THREAD_CREATE:fixture-session:3', 'system', null],
      ['second-account', 'MESSAGE_CREATE:fixture-session:4', 'message', null],
    ];
    for (const [channel, dispatch, kind, thread] of rows) insert.run(channel, dispatch, kind, Date.parse(message.timestamp), thread, JSON.stringify(message));
  } finally {
    database.close();
  }
}

function verifyReader(path) {
  const inbox = autoThreadInbox(path, account);
  try {
    const reader = inbox.refresh();
    assert.equal(reader.latest(), 5);
    const rows = reader.after(0);
    assert.deepEqual(rows.map(row => [row.id, row.thread]), [[1, null], [2, 'discord:fixture-thread']]);
    const { content, ...address } = message;
    for (const row of rows) assert.deepEqual(JSON.parse(row.message), {
      ...address, webhook_id: null, interaction_metadata: 0, message_reference: 0,
    });
  } finally {
    inbox.close();
  }
}

const [pots, log] = process.argv.slice(2);
assert.ok(pots && log && existsSync(log), 'Usage: node probes/discord-auto-thread-pots.mjs /path/to/pots /path/to/bot.sqlite');
const version = execFileSync(pots, ['--version'], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS }).trim();
assert.equal(version, SUPPORTED_VERSION);
const directory = mkdtempSync(join(tmpdir(), 'discord-auto-thread-pots-'));
try {
  const path = join(directory, 'bot.sqlite');
  seed(path, installedSchema(log));
  verifyReader(path);
  console.log(`${version}: installed schema, account filter, live dispatches, thread marker and raw message projection passed.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
