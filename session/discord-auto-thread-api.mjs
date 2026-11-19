import { operationOf } from './discord-admin-operations.mjs';

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const AUDIT_REASON = 'Automatic thread under Mastermind private channel rule';

function read(api, path, missingCode) {
  return api('GET', path).catch(error => {
    if (error.discordCode !== missingCode) throw error;
  });
}

export function autoThreadDiscord(api) {
  const channelPath = id => `/channels/${id}`;
  return {
    parent: ({ channelId }) => api('GET', channelPath(channelId)),
    message: ({ channelId, messageId }) => read(api, `${channelPath(channelId)}/messages/${messageId}`, UNKNOWN_MESSAGE),
    thread: ({ messageId }) => read(api, channelPath(messageId), UNKNOWN_CHANNEL),
    start: ({ guildId, channelId, messageId }, name) => {
      const { method, path, request } = operationOf({ action: 'thread.create', guildId, channelId, messageId, reason: AUDIT_REASON, payload: { name } });
      return api(method, path, request.payload, request.reason);
    },
  };
}
