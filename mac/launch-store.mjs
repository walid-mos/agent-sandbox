import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const NOTICE = '.notice';

export function gateStore(folder) {
  const shelf = join(folder, 'closed');
  privateDirectory(folder);
  privateDirectory(shelf);
  const path = (id, suffix) => {
    if (!DIALOG_ID.test(id)) throw new Error('mac-launch: invalid launch ID.');
    return join(folder, `${id}${suffix}`);
  };
  const read = (id, suffix) => existsSync(path(id, suffix)) ? readPrivate(path(id, suffix)) : undefined;
  const get = id => read(id, RECORD);
  const save = offer => { writePrivateJson(path(offer.request.launch, RECORD), offer); return offer; };
  function entries(suffix, onUnreadable = (id, error) => { throw error; }) {
    const names = readdirSync(folder).filter(name => name.endsWith(suffix) && DIALOG_ID.test(name.slice(0, -suffix.length)));
    return names.flatMap(name => {
      const id = name.slice(0, -suffix.length);
      try { return [read(id, suffix)]; } catch (error) { onUnreadable(id, error); return []; }
    });
  }
  const all = onUnreadable => entries(RECORD, onUnreadable);
  const notices = onUnreadable => entries(NOTICE, onUnreadable);
  const remember = (id, notice) => writePrivateJson(path(id, NOTICE), notice);
  const forget = id => rmSync(path(id, NOTICE), { force: true });
  const decision = id => read(id, DECISION);
  // The first decision written for a launch is its only one: the exclusive create refuses a second, and the file and its name reach the disk before anything acts on it.
  function decide(id, decided) {
    writeFileSync(path(id, DECISION), JSON.stringify(decided), { flag: 'wx', mode: 0o600, flush: true });
    const directory = openSync(folder, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  // Only the record leaves. The decision stays where the exclusive create looks, so a launch ID the Mac decided once is never decided or offered again.
  const shelve = id => renameSync(path(id, RECORD), join(shelf, `${id}${RECORD}`));
  const session = id => path(id, '.session.jsonl');
  return { get, save, all, notices, remember, forget, decision, decide, shelve, session, folder };
}
