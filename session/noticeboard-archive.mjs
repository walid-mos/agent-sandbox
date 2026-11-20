export const DISCORD_CONTENT = 2000;
export const messageLink = snapshot => `https://discord.com/channels/${snapshot.guildId}/${snapshot.channelId}/${snapshot.id}`;

export function prepareArchive(snapshot) {
  if (snapshot.attachments.length) return { reason: 'attachment-transport-unavailable' };
  const author = JSON.stringify(snapshot.author.displayName);
  const content = `Archived by automation. Original author: ${author}. Original: <${messageLink(snapshot)}>\n${JSON.stringify({ original: snapshot })}`;
  if (content.length > DISCORD_CONTENT) return { reason: 'text-archive-exceeds-limit' };
  return { archive: { content } };
}

export function matchesArchive(expected, actual, identity) {
  return actual?.isOwnedByApp === true && actual.id === identity.id && actual.channelId === identity.channelId && actual.content === expected.content;
}
