import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command } from './run.mjs';

const LINE_BREAK = /[\r\n]/;
const SESSION_LIBRARY = fileURLToPath(new URL('./lib.sh', import.meta.url));

// The `pots` on PATH is session/pots, so the installed package is found where lib.sh names it.
const upstreamPots = () => command('sh', ['-c', '. "$1" && printf %s "$POTS_UPSTREAM"', 'pots-secrets', SESSION_LIBRARY]);

// pots publishes no API, so its own check and writer are loaded from the dist folder of the installed `pots`.
async function potsModules() {
  const dist = dirname(dirname(realpathSync(upstreamPots())));
  const load = path => import(pathToFileURL(join(dist, path)).href);
  try {
    const [terminal, envFile, home] = await Promise.all(['channels/terminal/index.js', 'core/env-file.js', 'core/home.js'].map(load));
    return { secretRequest: terminal.secretRequest, writeSecrets: envFile.writeSecrets, secretsFolder: home.SECRETS_DIR };
  } catch (error) {
    throw new Error(`pots: this pots keeps its secret handling elsewhere than ${dist}. Update session/pots-secrets.mjs for it.`, { cause: error });
  }
}

function parsedSecrets(input) {
  // JSON.parse quotes what it read in its error, so that error never reaches the pane.
  try {
    return JSON.parse(input);
  } catch {
    throw new Error('pots: the secrets came unreadable. Type them again.');
  }
}

/** `{"KEY": "value"}`, each value trimmed as `pots chat` trims a typed line. */
function typedSecrets(input) {
  const typed = parsedSecrets(input);
  if (typed === null || typeof typed !== 'object' || Array.isArray(typed)) {
    throw new Error('pots: answer-secret reads {"KEY": "value"} on standard input.');
  }
  const values = Object.fromEntries(Object.entries(typed).map(([key, value]) => [key, `${value ?? ''}`.trim()]));
  if (Object.values(values).some(value => LINE_BREAK.test(value))) throw new Error('pots: a secret holds no line break. Type it again.');
  return values;
}

/**
 * Writes the values typed for one ask-secret, given as `{"KEY": "value"}` text, as `pots chat` does: pots checks the
 * file and the keys, writes the given keys to that file in its secrets folder, readable by this user only, and skips
 * the empty ones. Returns the message `pots chat` answers the bot with, which names the keys and never a value.
 */
export async function storeSecrets(asked, input) {
  const typed = typedSecrets(input);
  const { secretRequest, writeSecrets, secretsFolder } = await potsModules();
  const { file, keys } = secretRequest({ ...asked });
  const path = join(secretsFolder, file);
  const given = keys.filter(key => typed[key]);
  const skipped = keys.filter(key => !typed[key]);
  if (given.length) writeSecrets(path, Object.fromEntries(given.map(key => [key, typed[key]])));
  const written = [given.length ? `wrote ${given.join(', ')} to ${path}` : '', skipped.length ? `skipped ${skipped.join(', ')}` : '']
    .filter(Boolean).join('; ');
  return `(pots chat: ${written})`;
}
