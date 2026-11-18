import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { discordAdminApprovals } from '../session/discord-admin-approvals.mjs';
import { administerDiscord } from '../session/discord-admin-service.mjs';
import { acceptDiscordClick } from '../session/discord-clicks.mjs';
import { discordInbox } from '../session/discord-inbox.mjs';
import { humanStore } from '../session/human-store.mjs';
import { botId, channelId, fixture, guildId, ownerId, request, userId } from './fixtures/discord-admin.mjs';

const messageId = '100000000000000020';

function inboxRows(folder, interactions) {
  const path = join(folder, 'gateway.sqlite');
  const writer = new DatabaseSync(path);
  try {
    writer.exec('CREATE TABLE gw_events (id INTEGER PRIMARY KEY, channel TEXT, kind TEXT, at TEXT, text TEXT, person TEXT, place TEXT, thread TEXT, message TEXT, raw TEXT)');
    const insert = writer.prepare('INSERT INTO gw_events (channel, kind, text, person, message, raw) VALUES (?, ?, ?, ?, ?, ?)');
    for (const interaction of interactions) insert.run('discord', 'interaction', `clicked button "Approve this operation" (custom_id ${interaction.data.custom_id})`,
      `discord:@${ownerId}`, `discord:#${channelId}/${messageId}`, JSON.stringify(interaction));
  } finally { writer.close(); }
  const inbox = discordInbox(path);
  try { return inbox.after(0); }
  finally { inbox.close(); }
}

async function approval(t) {
  const folder = mkdtempSync(join(tmpdir(), 'discord-admin-inbox-'));
  const marker = join(folder, 'owner');
  t.after(() => {
    assert.equal(readFileSync(marker, 'utf8'), t.name);
    rmSync(folder, { recursive: true, force: true });
  });
  writeFileSync(marker, t.name);
  const clicks = humanStore(join(folder, 'clicks'));
  const pending = humanStore(join(folder, 'pending'));
  const dependencies = fixture();
  dependencies.approvals = discordAdminApprovals({ clicks, pending, channelAccount: 'discord', guildId, api: (...arguments_) => dependencies.api(...arguments_) });
  const prepared = await administerDiscord(request('channel.delete', { channelId }), dependencies);
  const posted = { id: messageId, channel_id: channelId, author: { id: botId, bot: true, username: 'discard this author field' }, ...prepared.message, embeds: [], attachments: [] };
  const api = dependencies.api;
  dependencies.api = (method, path, ...arguments_) => path === `/channels/${channelId}/messages/${messageId}` ? posted : api(method, path, ...arguments_);
  await dependencies.approvals.register({ dialog: prepared.approval, messages: [{ channelId, messageId }] });
  const enabled = posted.components.map(row => ({ ...row, components: row.components.map(button => ({ ...button, disabled: false })) }));
  return { folder, clicks, dependencies, id: prepared.approval, message: { ...posted, components: enabled, unrelated: 'discard this message field' } };
}

const interactionOf = (id, message) => ({ type: 3, guild_id: guildId, channel_id: channelId, member: { user: { id: ownerId }, nick: 'discard this member field' },
  message, data: { custom_id: `human:${id}:0:0` }, unrelated: 'discard this interaction field' });

function invalidDisplays(message) {
  return [
    { ...message, content: 'Approve a harmless health check' },
    { ...message, components: [{ type: 1, components: message.components[0].components.map(button => ({ ...button, label: 'Different operation' })) }] },
    { ...message, author: { id: userId, bot: true }, webhook_id: userId },
    { ...message, embeds: [{ description: 'An extra misleading display' }] },
    { ...message, attachments: [{ id: userId, filename: 'misleading.txt' }] },
    { id: messageId },
  ];
}

test('SQLite inbox accepts the canonical owner approval and refuses altered or webhook displays', async t => {
  const proof = await approval(t);
  const snapshots = [...invalidDisplays(proof.message), proof.message];
  const rows = inboxRows(proof.folder, snapshots.map(message => interactionOf(proof.id, message)));
  assert.equal(rows.length, 7);
  for (const row of rows.slice(0, -1)) {
    await assert.rejects(acceptDiscordClick(row, { store: proof.clicks, channelAccount: 'discord' }), /display/);
    assert.deepEqual(proof.clicks.get(proof.id).picks, {});
    assert.equal(proof.dependencies.mutations.length, 0);
  }
  const row = rows.at(-1);
  assert.equal((await acceptDiscordClick(row, { store: proof.clicks, channelAccount: 'discord' })).status, 'accepted');
  const projected = JSON.parse(row.raw);
  assert.equal(projected.unrelated, undefined);
  assert.equal(projected.member.nick, undefined);
  assert.equal(projected.message.unrelated, undefined);
  assert.equal(projected.message.author.username, undefined);
  assert.equal(projected.message.author.bot, true);
  const operation = proof.dependencies.approvals.approvedRequest(proof.id);
  assert.equal((await administerDiscord(operation, proof.dependencies)).status, 'completed');
  assert.deepEqual(proof.dependencies.mutations, [{ method: 'DELETE', path: `/channels/${channelId}`, body: undefined, reason: 'Requested server maintenance' }]);
});
