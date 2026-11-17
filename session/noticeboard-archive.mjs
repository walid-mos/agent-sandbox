import { attachmentOf, fingerprint, NOTICEBOARD_LIMITS } from './noticeboard-policy.mjs';

const DISCORD_CONTENT = 2000;
const encodedFile = (filename, bytes) => ({ filename, bytes: bytes.toString('base64'), sha256: fingerprint(bytes), size: bytes.length });
const messageLink = snapshot => `https://discord.com/channels/${snapshot.guildId}/${snapshot.channelId}/${snapshot.id}`;

export async function captureArchive(snapshot, client) {
  const files = [];
  for (const [index, attachment] of snapshot.attachments.entries()) {
    attachmentOf(attachment);
    const bytes = await client.download(attachment, { maxBytes: NOTICEBOARD_LIMITS.attachmentBytes, redirects: 'error' });
    if (!Buffer.isBuffer(bytes) || bytes.length !== attachment.size) throw new Error('noticeboards: attachment bytes unavailable or size differs.');
    files.push(encodedFile(`attachment-${index}-${attachment.filename}`, bytes));
  }
  const manifest = { original: snapshot, attachments: files.map(({ bytes, ...metadata }) => metadata) };
  files.push(encodedFile('noticeboard-original.json', Buffer.from(JSON.stringify(manifest))));
  const content = `Archived by automation. Original author: ${snapshot.author.displayName} (${snapshot.author.username}, ${snapshot.author.id})\nOriginal timestamp: ${snapshot.createdAt}\nEdited timestamp: ${snapshot.editedAt || 'never'}\nOriginal: <${messageLink(snapshot)}>\nExact original text and context are attached.\n\n${snapshot.content}`.slice(0, DISCORD_CONTENT);
  return { content, files, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } };
}

export function matchesArchive(expected, actual, route) {
  if (!actual || actual.isOwnedByApp !== true || actual.channelId !== route.threadId || actual.content !== expected.content || !Array.isArray(actual.files)) return false;
  if (actual.files.length !== expected.files.length) return false;
  return expected.files.every((file, index) => {
    const received = actual.files[index];
    if (received?.filename !== file.filename || typeof received.bytes !== 'string') return false;
    const bytes = Buffer.from(received.bytes, 'base64');
    return bytes.length === file.size && fingerprint(bytes) === file.sha256;
  });
}
