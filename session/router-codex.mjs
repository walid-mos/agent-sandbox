import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from './main.mjs';

export const CODEX_PUBLICATION = { path: '/clients/pi', name: 'PI_OAUTH_CODEX' };
export const CODEX_HOME = join(homedir(), '.local/state/agent-sandbox/codex');
export const MIN_VALIDITY_MS = 5 * 60 * 1000;
const OWNER_FILE = '.agent-sandbox';
const OWNER = 'router-codex';
const AUTH_FILE = 'auth.json';
const MALFORMED = 'router-codex: malformed access-only publication. Check the publisher. No credential values were printed.';
const FOREIGN = 'router-codex: directory belongs to another credential source.';
const UNREADABLE = 'router-codex: the managed auth.json is not JSON, so it is kept. Remove it when it holds no native sign-in. No credential values were printed.';

// A parse error quotes its input, which holds credential values, so a fixed message replaces it.
function parse(text, message = MALFORMED) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

function requirePublication(entry) {
  if (!entry || typeof entry !== 'object' || Object.hasOwn(entry, 'refresh') || Object.hasOwn(entry, 'refresh_token') ||
      typeof entry.access !== 'string' || !entry.access || /\s/u.test(entry.access) ||
      typeof entry.accountId !== 'string' || !entry.accountId || /\s/u.test(entry.accountId) || !Number.isFinite(entry.expires)) {
    throw new Error(MALFORMED);
  }
}

export function publication(text) {
  const entry = parse(text);
  requirePublication(entry);
  const parts = entry.access.split('.');
  if (parts.length !== 3) throw new Error(MALFORMED);
  const claims = parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!Number.isFinite(claims?.exp) || claims?.['https://api.openai.com/auth']?.chatgpt_account_id !== entry.accountId) throw new Error(MALFORMED);
  const expires = Math.min(entry.expires, claims.exp * 1000);
  if (expires <= Date.now() + MIN_VALIDITY_MS) {
    throw new Error('router-codex: publication expired or within five minutes of expiry. Run pi-token-sync --publish on the publishing machine.');
  }
  return { access: entry.access, accountId: entry.accountId, expires };
}

function requirePrivate(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('router-codex: managed credential path must be private, owned by this user and free of symlinks.');
  }
}

// The directory appears with its marker in one rename, so a concurrent sync never sees it unmarked.
function createHome() {
  mkdirSync(dirname(CODEX_HOME), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(`${CODEX_HOME}.`);
  try {
    writeFileSync(join(staging, OWNER_FILE), OWNER, { mode: 0o600, flag: 'wx' });
    renameSync(staging, CODEX_HOME);
  } catch (error) {
    if (!existsSync(CODEX_HOME)) throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function prepareHome() {
  if (!existsSync(CODEX_HOME)) createHome();
  requirePrivate(CODEX_HOME);
  const marker = join(CODEX_HOME, OWNER_FILE);
  if (!existsSync(marker)) throw new Error(FOREIGN);
  requirePrivate(marker);
  if (readFileSync(marker, 'utf8') !== OWNER) throw new Error(FOREIGN);
  const authPath = join(CODEX_HOME, AUTH_FILE);
  if (!existsSync(authPath)) return;
  requirePrivate(authPath);
  const current = parse(readFileSync(authPath, 'utf8'), UNREADABLE);
  if (current?.tokens?.refresh_token || current?.tokens?.id_token) throw new Error('router-codex: refusing to replace a native sign-in.');
}

function save(entry) {
  prepareHome();
  const temporary = join(CODEX_HOME, `${AUTH_FILE}.${randomUUID()}`);
  const auth = { auth_mode: 'chatgpt', tokens: { access_token: entry.access, account_id: entry.accountId, id_token: '', refresh_token: '' } };
  try {
    writeFileSync(temporary, `${JSON.stringify(auth)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(CODEX_HOME, AUTH_FILE));
  } finally {
    rmSync(temporary, { force: true });
  }
}

main(import.meta, () => {
  const text = process.env[CODEX_PUBLICATION.name];
  delete process.env[CODEX_PUBLICATION.name];
  if (!text) throw new Error('router-codex: run through node session/router.mjs sync.');
  const entry = publication(text);
  save(entry);
  process.stdout.write(`${JSON.stringify({ expires: entry.expires })}\n`);
});
