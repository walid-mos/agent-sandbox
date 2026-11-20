export const channelId = '11111111111111111';
export const messageId = '22222222222222222';
export const threadId = '33333333333333333';
export const authorId = '44444444444444444';
export const guildId = '55555555555555555';
export const copyId = '66666666666666666';

export const configuration = { enabled: true, channels: [{ channelId, guildId, threadId,
  parentMessageId: threadId, kind: 'pull-requests' }] };

export function source(overrides = {}) {
  return { id: messageId, channelId, guildId, type: 0, content: 'Please keep this comment. @everyone',
    author: { id: authorId, username: 'fixture-user', displayName: 'Fixture Person', isBot: false },
    createdAt: '2026-01-01T12:00:00.000Z', editedAt: '', attachments: [], components: [], embeds: [],
    isPinned: false, webhookId: '', reply: {}, thread: {}, ...overrides };
}

export function memoryStore() {
  const records = new Map();
  return { exclusive: operation => operation(), records: () => [...records.values()].map(record => structuredClone(record)),
    get: key => structuredClone(records.get(key)),
    put: record => records.set(record.key, structuredClone(record)) };
}

export function fixture(overrides = {}) {
  const store = memoryStore();
  const copies = new Map();
  const effects = [];
  let original = source(overrides);
  const client = {
    permissions: async () => ({ canRead: true, canWrite: true, canManageMessages: true, isThreadBound: true }),
    read: async () => structuredClone(original),
    react: async () => { effects.push('react'); },
    createCopy: async request => {
      effects.push('copy');
      const id = String(BigInt(copyId) + BigInt(copies.size));
      copies.set(id, { ...structuredClone(request), id, channelId: threadId, isOwnedByApp: true });
      return { id, channelId: threadId };
    },
    readCopy: async identity => structuredClone(copies.get(identity.id)),
    findCopy: async () => ({ status: 'unknown' }),
    remove: async () => { effects.push('delete'); original = undefined; },
  };
  return { store, client, copies, effects, configuration: structuredClone(configuration), now: Date.parse('2026-01-01T13:00:00.000Z'),
    event: { id: 1, channelId, messageId, kind: 'create' },
    edit: update => { original = { ...original, ...update }; } };
}
