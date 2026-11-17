import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIALOG_ID } from '../session/human-contract.mjs';

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

export function writePrivate(path, value) {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(staging, path);
}

export function gateStore(folder) {
  privateDirectory(folder);
  const path = (id, suffix) => {
    if (!DIALOG_ID.test(id)) throw new Error('mac-launch: invalid launch ID.');
    return join(folder, `${id}${suffix}`);
  };
  const get = id => existsSync(path(id, '.json')) ? readPrivate(path(id, '.json')) : undefined;
  const save = offer => { writePrivate(path(offer.request.launch, '.json'), offer); return offer; };
  const all = () => readdirSync(folder).filter(name => name.endsWith('.json') && DIALOG_ID.test(name.slice(0, -5))).map(name => get(name.slice(0, -5)));
  const used = id => existsSync(path(id, '.used'));
  const consume = approval => writeFileSync(path(approval.launch, '.used'), JSON.stringify(approval), { flag: 'wx', mode: 0o600, flush: true });
  const approval = id => readPrivate(path(id, '.used'));
  const session = id => path(id, '.session.jsonl');
  return { get, save, all, used, consume, approval, session, folder };
}
