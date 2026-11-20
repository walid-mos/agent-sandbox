import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { landingRepository } from './factory-authority.mjs';
import { FACTORY_HOME } from './factory-records.mjs';
import { releaseGit } from './factory-release-git.mjs';
import { remoteUrl } from './github-url.mjs';
import { command } from './run.mjs';

// The mirror is only ever written by git fetching from GitHub: no checked code runs in it and no checkout of it is mounted anywhere.
const MIRRORS = join(FACTORY_HOME, 'mirrors');

const mirrorPath = repository => join(MIRRORS, `${repository}.git`);
export const landingGit = () => releaseGit(mirrorPath(landingRepository), remoteUrl(landingRepository));
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

export function writeCommit(repository, object) {
  return inMirror(repository, ['hash-object', '-w', '-t', 'commit', '--stdin'], { input: object });
}

export function pushCommit(repository, commit, branch) {
  inMirror(repository, ['push', '--quiet', remoteUrl(repository), `${commit}:refs/heads/${branch}`]);
}

export function changeText(repository, base, head) {
  return inMirror(repository, ['diff', '--stat', '--patch', '--no-ext-diff', '--no-textconv', base, head]);
}

// A copy, not hardlinks: code in the copy can rewrite its files, and those must never be the mirror's objects.
export function copyAt(repository, revision, destination) {
  command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', mirrorPath(repository), destination]);
  command('git', ['-C', destination, 'checkout', '--quiet', '--detach', revision]);
}
