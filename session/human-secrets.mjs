import { homedir } from 'node:os';
import { join } from 'node:path';
import { handOffBrowserSecret } from './human-browser.mjs';
import { BROWSER_KEY, targetKeys } from './human-contract.mjs';
import { requireSecretKeys } from './human-secret-values.mjs';
import { storeSecrets } from './pots-secrets.mjs';
import { humanStore } from './human-store.mjs';
import { commandWithInput } from './run.mjs';

const VALUE_LIMIT = 4096;
const SECURITY = join(homedir(), '.pi/agent/security');
const WRITE_MS = 120_000;

async function writeInfisical(target, value) {
  const targetArguments = ['--projectId', target.projectId, '--env', target.environment, '--path', target.path];
  try {
    await commandWithInput('node', [join(SECURITY, 'secret-names.mjs'), ...targetArguments], '', { timeout: WRITE_MS });
  } catch {
    throw new Error('human: the vault access check failed before writing. Restore access, then retry this request.');
  }
  const arguments_ = [join(SECURITY, 'secret-set.mjs'), ...targetArguments, '--name', target.name];
  if (target.replace) arguments_.push('--replace');
  return commandWithInput('node', arguments_, value, { timeout: WRITE_MS }).catch(() => {
    throw Object.assign(new Error('human: the vault write outcome is unknown. Verify the destination before opening a new request.'), { isUncertain: true });
  });
}

function checkedValues(target, values) {
  const keys = targetKeys(target);
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !keys.includes(key))) throw new Error('human: enter only the requested secret keys.');
  requireSecretKeys(keys, values);
  if (keys.some(key => values[key].length > VALUE_LIMIT || /[\r\n\0]/.test(values[key]))) throw new Error(`human: each secret needs a single line of at most ${VALUE_LIMIT} characters.`);
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
    const receipt = await attemptWrite(dialog, checked, { save, write });
    return save({ ...dialog, result: { status: 'stored', origin, at: Date.now(), dialog: id, request: dialog.delivery?.id, ...receipt } });
  }, id);
}

async function attemptWrite(dialog, values, { save, write }) {
  try {
    return await write(dialog, values);
  } catch (error) {
    if (!error.isUncertain) save({ ...dialog, writing: false });
    throw error;
  }
}

async function writePots(target, values) {
  try {
    await storeSecrets({ file: target.file, keys: target.keys }, JSON.stringify(values));
  } catch (error) {
    throw Object.assign(new Error('human: the pot did not confirm the secret file write. Check the destination before retrying.'), { isUncertain: error.isUncertain === true });
  }
}

const WRITERS = {
  infisical: async ({ target }, values) => { await writeInfisical(target, values[target.name]); return {}; },
  pots: async ({ target }, values) => { await writePots(target, values); return {}; },
  browser: (dialog, values) => handOffBrowserSecret(dialog, values[BROWSER_KEY]),
};

const writeTarget = (dialog, values) => WRITERS[dialog.target.destination](dialog, values);
