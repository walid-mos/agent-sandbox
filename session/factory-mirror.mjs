import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FACTORY_HOME } from './factory-records.mjs';
import { command } from './run.mjs';

// The mirror is only ever written by git fetching from GitHub: no checked code runs in it and no checkout of it is mounted anywhere.
const MIRRORS = join(FACTORY_HOME, 'mirrors');

export const remoteUrl = repository => `https://github.com/${repository}.git`;
const mirrorPath = repository => join(MIRRORS, `${repository}.git`);
const inMirror = (repository, arguments_, options) => command('git', ['-C', mirrorPath(repository), ...arguments_], options);

export function refreshMirror(repository) {
  const mirror = mirrorPath(repository);
  if (existsSync(mirror)) {
    inMirror(repository, ['fetch', '--quiet', '--prune', 'origin']);
    return;
  }
  mkdirSync(dirname(mirror), { recursive: true });
  command('git', ['clone', '--quiet', '--mirror', remoteUrl(repository), mirror]);
}

export function mergeBase(repository, baseBranch, head) {
  return inMirror(repository, ['merge-base', `refs/heads/${baseBranch}`, head]);
}

export function branchTip(repository, branch) {
  return inMirror(repository, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
}

export function publishLanding(repository, release) {
  refreshMirror(repository);
  const commit = inMirror(repository, ['hash-object', '-w', '-t', 'commit', '--stdin'], { input: Buffer.from(release.object, 'base64') });
  if (commit !== release.commit) throw new Error('factory: the signed object does not match the signer receipt. Nothing was pushed.');
  inMirror(repository, ['push', '--quiet', remoteUrl(repository), `${commit}:refs/heads/main`]);
  refreshMirror(repository);
  if (branchTip(repository, 'main') !== commit) throw new Error('factory: signed publication is not the remote main tip. Installation is unconfirmed.');
}

export function changeText(repository, base, head) {
  return inMirror(repository, ['diff', '--stat', '--patch', '--no-ext-diff', '--no-textconv', base, head]);
}

// A copy, not hardlinks: code in the copy can rewrite its files, and those must never be the mirror's objects.
export function copyAt(repository, revision, destination) {
  command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', mirrorPath(repository), destination]);
  command('git', ['-C', destination, 'checkout', '--quiet', '--detach', revision]);
}
