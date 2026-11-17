import { homedir } from 'node:os';
import { join } from 'node:path';
import { handOffBrowserSecret } from './human-browser.mjs';
import { BROWSER_KEY, targetKeys } from './human-contract.mjs';
import { storeSecrets } from './pots-secrets.mjs';
import { humanStore } from './human-store.mjs';
import { commandWithInput } from './run.mjs';

const VALUE_LIMIT = 4096;
const WRITER = join(homedir(), '.pi/agent/security/secret-set.mjs');

function writeInfisical(target, value) {
  const arguments_ = [WRITER, '--projectId', target.projectId, '--env', target.environment, '--name', target.name, '--path', target.path];
  if (target.replace) arguments_.push('--replace');
  return commandWithInput('node', arguments_, value, { timeout: 120_000 }).catch(() => {
    throw new Error('human: the vault did not confirm the write. Check its access before trying a new request.');
  });
}

function checkedValues(target, values) {
  const keys = targetKeys(target);
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !keys.includes(key))) throw new Error('human: enter only the requested secret keys.');
  if (keys.some(key => typeof values[key] !== 'string' || !values[key].trim() || values[key].length > VALUE_LIMIT || /[\r\n\0]/.test(values[key]))) throw new Error(`human: each secret needs a single line of at most ${VALUE_LIMIT} characters.`);
  return Object.fromEntries(keys.map(key => [key, values[key]]));
}

export async function storeDialogSecret(id, values, { store = humanStore(), origin = 'terminal', write = writeTarget } = {}) {
  return store.locked(async ({ get, save }) => {
    const dialog = get(id);
    if (dialog?.kind !== 'secret') throw new Error('human: no such secret request.');
    if (dialog.result) return dialog;
    if (dialog.expiresAt <= Date.now()) throw new Error('human: this secret page expired. Ask for a new request.');
    if (dialog.writing) throw new Error('human: a previous write was interrupted. Verify the destination and open a new request.');
    const checked = checkedValues(dialog.target, values);
    save({ ...dialog, writing: true });
    const receipt = await write(dialog, checked);
    return save({ ...dialog, result: { status: 'stored', origin, at: Date.now(), dialog: id, request: dialog.delivery?.id, ...receipt } });
  }, id);
}

async function writePots(target, values) {
  try {
    await storeSecrets({ file: target.file, keys: target.keys }, JSON.stringify(values));
  } catch {
    throw new Error('human: the pot did not confirm the secret file write. Check it before opening a new request.');
  }
}

const WRITERS = {
  infisical: async ({ target }, values) => { await writeInfisical(target, values[target.name]); return {}; },
  pots: async ({ target }, values) => { await writePots(target, values); return {}; },
  browser: (dialog, values) => handOffBrowserSecret(dialog, values[BROWSER_KEY]),
};

const writeTarget = (dialog, values) => WRITERS[dialog.target.destination](dialog, values);
