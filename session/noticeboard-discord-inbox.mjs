import { DatabaseSync } from 'node:sqlite';
import { noticeboardDiscordScope } from './noticeboard-discord.mjs';
import { NOTICEBOARD_LIMITS } from './noticeboard-policy.mjs';

const EVENT_KINDS = Object.freeze({ message: 'create', edit: 'update', delete: 'delete' });
const ROUTE_MATCH = "(json_extract(payload, '$.channel_id') = ? AND json_extract(payload, '$.guild_id') = ?)";

export function noticeboardDiscordInbox(path, scope) {
  const { account, channels } = noticeboardDiscordScope(scope);
  const kinds = Object.keys(EVENT_KINDS);
  const query = `WITH scoped AS (
    SELECT id, kind, CASE WHEN length(CAST(raw AS BLOB)) <= ? AND json_valid(raw) THEN raw END AS payload
    FROM gw_events WHERE id > ? AND channel = ? AND kind IN (${kinds.map(() => '?').join(', ')})
  ) SELECT id, kind, json_extract(payload, '$.channel_id') AS channelId, json_extract(payload, '$.id') AS messageId
    FROM scoped WHERE (${channels.map(() => ROUTE_MATCH).join(' OR ')})
    AND json_type(payload, '$.id') = 'text' AND length(json_extract(payload, '$.id')) BETWEEN 17 AND 20
    AND json_extract(payload, '$.id') NOT GLOB '*[^0-9]*' ORDER BY id LIMIT ?`;
  const routeKeys = channels.flatMap(route => [route.channelId, route.guildId]);
  return cursor => {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('noticeboards: invalid gateway cursor.');
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(query).all(NOTICEBOARD_LIMITS.snapshotBytes, cursor, account, ...kinds, ...routeKeys, NOTICEBOARD_LIMITS.batch)
        .map(({ id, kind, channelId, messageId }) => ({ id, kind: EVENT_KINDS[kind], channelId, messageId }));
    } finally {
      database.close();
    }
  };
}
