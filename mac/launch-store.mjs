import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIALOG_ID } from '../session/human-contract.mjs';
import { writePrivateJson } from '../session/private-json.mjs';

export function privateDirectory(folder) {
  mkdirSync(folder, { mode: 0o700, recursive: true });
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('mac-launch: the settings directory must belong only to this user, mode 700.');
}

export function readPrivate(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('mac-launch: settings and state must be private regular files, mode 600.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

const RECORD = '.json';
const DECISION = '.decision';

export function gateStore(folder) {
  privateDirectory(folder);
  const path = (id, suffix) => {
    if (!DIALOG_ID.test(id)) throw new Error('mac-launch: invalid launch ID.');
    return join(folder, `${id}${suffix}`);
  };
  const read = (id, suffix) => existsSync(path(id, suffix)) ? readPrivate(path(id, suffix)) : undefined;
  const get = id => read(id, RECORD);
  const save = offer => { writePrivateJson(path(offer.request.launch, RECORD), offer); return offer; };
  const all = () => readdirSync(folder).filter(name => name.endsWith(RECORD) && DIALOG_ID.test(name.slice(0, -RECORD.length))).map(name => get(name.slice(0, -RECORD.length)));
  const decision = id => read(id, DECISION);
  // The first decision written for a launch is its only one: the exclusive create refuses a second, and the file and its name reach the disk before anything acts on it.
  function decide(id, decided) {
    writeFileSync(path(id, DECISION), JSON.stringify(decided), { flag: 'wx', mode: 0o600, flush: true });
    const directory = openSync(folder, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  const session = id => path(id, '.session.jsonl');
  return { get, save, all, decision, decide, session, folder };
}
