import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { targetKeys } from './human-contract.mjs';
import { storeDialogSecret } from './human-secrets.mjs';
import { humanStore } from './human-store.mjs';
import { commandOutput } from './run.mjs';
import { botId, potsHome } from './sandbox.mjs';

const PAGE_COMMAND_MS = 15_000;

async function pageCommand(binary, arguments_) {
  try { return await commandOutput(binary, arguments_, { timeout: PAGE_COMMAND_MS }); }
  catch { throw new Error('human: the native secret page service is unavailable. Check Pots and the tailnet page proxy.'); }
}

function checkedPageOrigin(settings, serve) {
  let url;
  try { url = new URL(settings.publicUrl); } catch { throw new Error('human: configure a tailnet publicUrl before making a secret link.'); }
  const host = url.host.includes(':') ? url.host : `${url.host}:443`;
  let proxy;
  try { proxy = new URL(serve.Web?.[host]?.Handlers?.['/']?.Proxy); } catch { throw new Error('human: the configured page proxy is not served.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.ts.net') || url.pathname !== '/' || url.search || url.hash
    || serve.AllowFunnel?.[host] === true || proxy.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(proxy.hostname) || proxy.port !== `${settings.pagePort}` || proxy.pathname !== '/' || proxy.username || proxy.password) {
    throw new Error('human: publicUrl must be the tailnet-link proxy of the local Pots page port, without Funnel.');
  }
  return url.origin;
}

async function pageOrigin() {
  const settings = JSON.parse(readFileSync(join(potsHome, 'settings.json'), 'utf8'));
  const serve = JSON.parse(await pageCommand('tailscale', ['serve', 'status', '--json']));
  return checkedPageOrigin(settings, serve);
}

const isOpen = dialog => !dialog.result && !dialog.writing && dialog.expiresAt > Date.now();
const stageFile = id => `human-${id}.env`;
const stagePath = id => join(homedir(), '.pots/secrets', stageFile(id));

export async function ensureSecretPage(id, store = humanStore()) {
  const known = store.get(id);
  if (!isOpen(known) || known.pageLink) return known;
  const origin = await pageOrigin();
  return store.locked(async ({ get, save }) => {
    const dialog = get(id);
    if (!isOpen(dialog) || dialog.pageLink) return dialog;
    const output = await pageCommand('pots', ['page', 'secret', '--bot', botId, '--file', stageFile(id), '--keys', targetKeys(dialog.target).join(','), '--text', dialog.purpose]);
    const issued = JSON.parse(output);
    if (issued.via !== 'public-url' || new URL(issued.url).origin !== origin || !/^S\d+$/.test(issued.link)) throw new Error('human: Pots did not return the configured tailnet secret link.');
    return save({ ...dialog, pageLink: { id: issued.link, url: issued.url, expires: issued.expires } });
  }, id);
}

// Pots' page writes its own claim line beside the values, marked with a leading #.
export function stagedValues(dialog) {
  const pairs = readFileSync(stagePath(dialog.id), 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  return Object.fromEntries(pairs);
}

// The staged value leaves the disk after one attempt, whatever its outcome: an interrupted write never accepts a second one.
async function submitStaged(dialog, store) {
  try {
    return await storeDialogSecret(dialog.id, stagedValues(dialog), { store, origin: 'page' });
  } finally {
    rmSync(stagePath(dialog.id), { force: true });
  }
}

async function revokePage(dialog, store) {
  const { id } = dialog;
  try {
    rmSync(stagePath(id), { force: true });
    if (dialog.pageRevoked) return dialog;
    await pageCommand('pots', ['page', 'unlink', '--bot', botId, dialog.pageLink.id]);
    return await store.patch(id, { pageRevoked: true });
  } catch {
    return dialog;
  }
}

export async function syncSecretPage(id, store = humanStore()) {
  const dialog = store.get(id);
  if (!dialog?.pageLink) return dialog;
  const current = isOpen(dialog) && existsSync(stagePath(id)) ? await submitStaged(dialog, store) : dialog;
  return isOpen(current) ? current : revokePage(current, store);
}
