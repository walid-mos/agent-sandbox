import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basicEnvironment } from './environment.mjs';
import { botSecretFiles } from './bot-secrets-config.mjs';
import { main } from './main.mjs';
import { sandbox } from './sandbox.mjs';
import { readSecret } from './vault.mjs';

const PRIVATE_FILE_WRITER = fileURLToPath(new URL('./private_file.py', import.meta.url));
const DIRECTORY_REFUSED = 73;
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
  const { status } = spawnSync('python3', ['-I', PRIVATE_FILE_WRITER, '.pots/secrets', file], {
    input: content, env: basicEnvironment(process.env), stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (status === DIRECTORY_REFUSED) {
    throw new Error('bot-secrets: ~/.pots and ~/.pots/secrets must be directories owned by the session user, without symlinks.');
  }
  if (status !== 0) throw new Error(`bot-secrets: cannot replace ${file} in the Pots secrets directory.`);
}

main(import.meta, async () => {
  for (const { file, entries } of botSecretFiles(sandbox)) {
    const lines = await Promise.all(entries.map(secretLine));
    save(file, lines.join(''));
  }
});
