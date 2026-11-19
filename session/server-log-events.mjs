import { randomUUID } from 'node:crypto';

export const SERVER_LOG_EVENT = Object.freeze({
  sourceRefreshFailed: 'source-refresh.failed',
  adminTopicChanged: 'admin.channel-topic-changed',
});

const NOTICES = Object.freeze({
  [SERVER_LOG_EVENT.sourceRefreshFailed]: {
    service: 'pots-sources', level: 'WARNING', impact: 'Automatic source provisioning did not complete.',
    followUp: 'Recovery: The next scheduled refresh retries. Inspect local service logs if it keeps failing.',
  },
  [SERVER_LOG_EVENT.adminTopicChanged]: {
    service: 'Discord Admin', level: 'AUDIT', impact: 'A Discord channel topic changed.',
    followUp: 'Status: Confirmed by reading back the updated topic.',
  },
});
const EVENT_FIELDS = ['id', 'kind', 'at'];
const EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const POT_LABEL = /^[a-z][a-z0-9-]{0,62}$/u;

export function isServerLogEnabled(environment = process.env) {
  return environment.AGENT_SANDBOX_SERVER_LOG_EVENTS === '1';
}

export function serverLogEvent(kind, now) {
  if (!Object.hasOwn(NOTICES, kind)) throw new Error('server-log: unknown event kind.');
  return { id: randomUUID(), kind, at: now.toISOString() };
}

function isEvent(event) {
  if (!event || Object.keys(event).length !== EVENT_FIELDS.length || !EVENT_FIELDS.every(field => Object.hasOwn(event, field))) return false;
  if (typeof event.kind !== 'string' || !Object.hasOwn(NOTICES, event.kind)) return false;
  if (typeof event.id !== 'string' || !EVENT_ID.test(event.id) || typeof event.at !== 'string') return false;
  const timestamp = Date.parse(event.at);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === event.at;
}

export function renderServerLog(event, potLabel) {
  if (!isEvent(event)) throw new Error('server-log: invalid event.');
  if (typeof potLabel !== 'string' || !POT_LABEL.test(potLabel)) throw new Error('server-log: invalid owner-bound pot label.');
  const { service, level, impact, followUp } = NOTICES[event.kind];
  return {
    content: `${potLabel} / ${service} · ${level} · ${event.at}\nImpact: ${impact}\n${followUp}`,
    allowed_mentions: { parse: [] },
  };
}
