import { readFileSync } from 'node:fs';
import { main } from './main.mjs';

const INVALID_FILE_CHARACTER = /[^A-Za-z0-9_.-]/u;
const isFileName = file => file.length > 0 && file !== '.' && file !== '..' && !INVALID_FILE_CHARACTER.test(file);
const CONFIG_ERROR = 'bot-secrets: sandbox.json needs botSecrets as plain file names mapped to existing onRequest groups with lists of unique secret names.';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function groupEntries(folders) {
  if (!isObject(folders)) throw new Error(CONFIG_ERROR);
  const entries = Object.entries(folders).flatMap(([path, names]) => {
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) throw new Error(CONFIG_ERROR);
    return names.map(name => ({ path, name }));
  });
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error(CONFIG_ERROR);
  return entries;
}

export function botSecretFiles(sandbox) {
  if (sandbox.botSecrets === undefined) return [];
  if (!isObject(sandbox.botSecrets)) throw new Error(CONFIG_ERROR);
  return Object.entries(sandbox.botSecrets).map(([file, group]) => {
    if (!isFileName(file) || typeof group !== 'string' || !isObject(sandbox.onRequest) || !Object.hasOwn(sandbox.onRequest, group)) {
      throw new Error(CONFIG_ERROR);
    }
    return { file, entries: groupEntries(sandbox.onRequest[group]) };
  });
}

main(import.meta, () => {
  for (const path of process.argv.slice(2)) botSecretFiles(JSON.parse(readFileSync(path, 'utf8')));
});
