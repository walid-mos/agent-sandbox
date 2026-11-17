import { DatabaseSync } from 'node:sqlite';

const READ_LIMIT = 100;
const INTERACTIONS = `SELECT id, channel, at, json_object(
  'id', json_extract(raw, '$.id'),
  'type', json_extract(raw, '$.type'),
  'guild_id', json_extract(raw, '$.guild_id'),
  'channel_id', json_extract(raw, '$.channel_id'),
  'member', json_object('user', json_object('id', json_extract(raw, '$.member.user.id'))),
  'user', json_object('id', json_extract(raw, '$.user.id')),
  'message', json_object('id', json_extract(raw, '$.message.id'), 'components', json_extract(raw, '$.message.components')),
  'data', json_extract(raw, '$.data')
) AS interaction FROM gw_events WHERE id > ? AND kind = 'interaction' AND json_valid(raw) ORDER BY id LIMIT ?`;

export function discordInbox(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  const query = database.prepare(INTERACTIONS);
  return { after: cursor => query.all(cursor, READ_LIMIT).map(row => ({ ...row, interaction: JSON.parse(row.interaction) })) };
}
