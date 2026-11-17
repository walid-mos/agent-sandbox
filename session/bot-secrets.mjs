import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

function save(file, content) {
  const staging = join(SECRETS_HOME, `.${file}.${randomUUID()}`);
  try {
    mkdirSync(SECRETS_HOME, { recursive: true, mode: 0o700 });
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
