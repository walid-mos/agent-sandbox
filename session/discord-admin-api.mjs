import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const ORIGIN = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 10000;
const RATE_LIMIT = 429;
const FORBIDDEN = 403;

function tokenAt(reference) {
  try {
    const path = reference.startsWith('~/') ? join(homedir(), reference.slice(2)) : resolve(reference);
    const secretDirectory = join(homedir(), '.pots/secrets');
    const file = lstatSync(path);
    if (!path.startsWith(`${secretDirectory}${sep}`) || realpathSync(path) !== path || !file.isFile()
      || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) throw new Error();
    const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim());
    const assignments = lines.filter(line => line.startsWith('DISCORD_BOT_TOKEN='));
    if (assignments.length !== 1) throw new Error();
    const token = assignments[0].slice('DISCORD_BOT_TOKEN='.length);
    if (!token || /[\s\0]/.test(token)) throw new Error();
    return token;
  } catch {
    throw new Error('discord-admin: existing Discord token reference is missing or unsafe. Restore its private file, without submitting its value.');
  }
}

export function discordAdminApi(reference, transport = fetch) {
  return async (method, path, payload, reason) => {
    const token = tokenAt(reference);
    let response;
    try {
      response = await transport(`${ORIGIN}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...(reason && { 'X-Audit-Log-Reason': encodeURIComponent(reason) }) },
        ...(payload !== undefined && { body: JSON.stringify(payload) }) });
    } catch {
      throw new Error('discord-admin: Discord request failed or timed out. Mutation outcome may be unknown. Inspect before any new attempt.');
    }
    let result;
    try { result = response.status === 204 ? {} : await response.json(); } catch { throw new Error('discord-admin: Discord returned unreadable JSON. Inspect the resource before retrying.'); }
    if (response.ok) return result;
    const code = Number.isInteger(result?.code) ? `, code ${result.code}` : '';
    const hint = response.status === RATE_LIMIT ? 'Rate limited. Wait for Discord before a new request.'
      : response.status === FORBIDDEN ? 'Missing application permission, channel access, member intent or role hierarchy. Inspect current diagnostics and channel policy.' : 'Inspect this resource before a new request.';
    throw new Error(`discord-admin: Discord HTTP ${response.status}${code}. ${hint}`);
  };
}
