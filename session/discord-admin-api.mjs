import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const ORIGIN = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 10000;
const HINTS = {
  429: 'Rate limited. Wait for Discord before a new request.',
  403: 'Missing application permission, channel access, member intent or role hierarchy. Inspect current diagnostics and channel policy.',
};

function privateTokenPath(reference) {
  const path = reference.startsWith('~/') ? join(homedir(), reference.slice(2)) : resolve(reference);
  const secretDirectory = join(homedir(), '.pots/secrets');
  const file = lstatSync(path);
  const inside = realpathSync(path).startsWith(`${realpathSync(secretDirectory)}${sep}`);
  const checks = [inside, file.isFile(), file.uid === process.getuid(), (file.mode & 0o077) === 0];
  if (!checks.every(Boolean)) throw new Error();
  return path;
}

function readToken(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim());
  const assignments = lines.filter(line => line.startsWith('DISCORD_BOT_TOKEN='));
  if (assignments.length !== 1) throw new Error();
  const token = assignments[0].slice('DISCORD_BOT_TOKEN='.length);
  if (!token || /[\s\0]/.test(token)) throw new Error();
  return token;
}

function tokenAt(reference) {
  try { return readToken(privateTokenPath(reference)); }
  catch { throw new Error('discord-admin: existing Discord token reference is missing or unsafe. Restore its private file, without submitting its value.'); }
}

function requestOptions(method, payload, reason, token) {
  return { method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...(reason && { 'X-Audit-Log-Reason': encodeURIComponent(reason) }) },
    ...(payload !== undefined && { body: JSON.stringify(payload) }) };
}

async function responseBody(response) {
  try { return response.status === 204 ? {} : await response.json(); }
  catch { throw new Error('discord-admin: Discord returned unreadable JSON. Inspect the resource before retrying.'); }
}

function discordFailure(response, result) {
  const discordCode = Number.isInteger(result?.code) ? result.code : undefined;
  const code = discordCode === undefined ? '' : `, code ${discordCode}`;
  const hint = HINTS[response.status] ?? 'Inspect this resource before a new request.';
  return Object.assign(new Error(`discord-admin: Discord HTTP ${response.status}${code}. ${hint}`), { discordCode });
}

async function discordResult(response) {
  if (response.ok) return responseBody(response);
  throw discordFailure(response, await response.json().catch(() => undefined));
}

async function request(transport, token, method, path, payload, reason) {
  let response;
  try { response = await transport(`${ORIGIN}${path}`, requestOptions(method, payload, reason, token)); }
  catch { throw new Error('discord-admin: Discord request failed or timed out. Mutation outcome may be unknown. Inspect before any new attempt.'); }
  return discordResult(response);
}

export function discordAdminApi(reference, transport = fetch) {
  let token;
  let identity;
  return async (method, path, payload, reason) => {
    token ??= tokenAt(reference);
    if (method !== 'GET' || path !== '/users/@me') return request(transport, token, method, path, payload, reason);
    identity ??= request(transport, token, method, path);
    return identity.catch(error => { identity = undefined; throw error; });
  };
}
