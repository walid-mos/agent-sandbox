import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { storeSecrets } from './pots-secrets.mjs';
import { humanStore } from './human-store.mjs';

const VALUE_LIMIT = 4096;
const WRITER = join(homedir(), '.pi/agent/security/secret-set.mjs');

function writeInfisical(target, value) {
  const arguments_ = [WRITER, '--projectId', target.projectId, '--env', target.environment, '--name', target.name, '--path', target.path];
  if (target.replace) arguments_.push('--replace');
  return new Promise((resolve, reject) => {
    const writer = execFile('node', arguments_, { timeout: 120_000 }, error => {
      if (error) reject(new Error('human: the vault did not confirm the write. Check its access before trying a new request.'));
      else resolve();
    });
    writer.stdin.on('error', () => {});
    writer.stdin.end(value);
  });
}

function checkedValues(target, values) {
  const keys = target.destination === 'pots' ? target.keys : [target.name];
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !keys.includes(key))) throw new Error('human: enter only the requested secret keys.');
  if (keys.some(key => typeof values[key] !== 'string' || !values[key].trim() || values[key].length > VALUE_LIMIT || /[\r\n\0]/.test(values[key]))) throw new Error('human: each secret needs a single line of at most 4096 characters.');
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
    await write(dialog.target, checked);
    return save({ ...dialog, result: { status: 'stored', origin, at: Date.now() } });
  }, id);
}

async function writeTarget(target, values) {
  if (target.destination === 'infisical') return writeInfisical(target, values[target.name]);
  try {
    await storeSecrets({ file: target.file, keys: target.keys }, JSON.stringify(values));
  } catch {
    throw new Error('human: the pot did not confirm the secret file write. Check it before opening a new request.');
  }
}
