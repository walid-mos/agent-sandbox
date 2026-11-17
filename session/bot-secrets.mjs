import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { botSecretFiles } from './bot-secrets-config.mjs';
import { main } from './main.mjs';
import { potsHome, sandbox } from './sandbox.mjs';
import { readSecret } from './vault.mjs';

const SECRETS_HOME = join(potsHome, 'secrets');
const LINE_BREAK_OR_NUL = /[\r\n\0]/u;

async function secretLine({ path, name }) {
  try {
    const value = await readSecret(path, name);
    if (typeof value !== 'string' || !value || LINE_BREAK_OR_NUL.test(value)) throw new Error();
    return `${name}=${value}\n`;
  } catch {
    throw new Error(`bot-secrets: cannot read a non-empty single-line value for ${path}/${name} from the vault.`);
  }
}

function prepareDirectory(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error();
}

function prepareHome() {
  try {
    prepareDirectory(potsHome);
    prepareDirectory(SECRETS_HOME);
  } catch {
    throw new Error('bot-secrets: ~/.pots and ~/.pots/secrets must be directories owned by the session user, without symlinks.');
  }
}

function save(file, content) {
  prepareHome();
  const staging = join(SECRETS_HOME, `.${file}.${randomUUID()}`);
  try {
    writeFileSync(staging, content, { mode: 0o600, flag: 'wx' });
    renameSync(staging, join(SECRETS_HOME, file));
  } catch {
    throw new Error(`bot-secrets: cannot replace ${file} in the Pots secrets directory.`);
  } finally {
    rmSync(staging, { force: true });
  }
}

main(import.meta, async () => {
  for (const { file, entries } of botSecretFiles(sandbox)) {
    const lines = await Promise.all(entries.map(secretLine));
    save(file, lines.join(''));
  }
});
