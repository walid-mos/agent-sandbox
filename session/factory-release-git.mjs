import { isDeepStrictEqual } from 'node:util';
import { command } from './run.mjs';

const reviewedHeadRef = commit => `refs/tags/factory-reviewed/${commit}`;
const squashTagName = commit => `factory-release/${commit}`;
const squashTagRef = commit => `refs/tags/${squashTagName(commit)}`;
const squashSubject = 'Factory squash evidence v1';

function storeSquashEvidence(git, release, request) {
  if (!isDeepStrictEqual(release?.request, request) || typeof release.object !== 'string') {
    throw new Error('factory: signer receipt differs from the observed squash.');
  }
  const tag = git(['hash-object', '-w', '-t', 'tag', '--stdin'], { input: Buffer.from(release.object, 'base64') });
  if (release.tag !== tag) throw new Error('factory: signed tag object differs from the signer receipt.');
  const object = git(['cat-file', 'tag', tag]);
  const messageStart = object.indexOf('\n\n');
  const [target, type, name] = object.slice(0, messageStart).split('\n');
  const message = object.slice(messageStart + 2);
  const payload = JSON.stringify(Object.fromEntries(Object.keys(request).sort().map(key => [key, request[key]])));
  const expected = `${squashSubject}\n\n${payload}\n-----BEGIN PGP SIGNATURE-----\n`;
  if (target !== `object ${request.squash}` || type !== 'type commit'
      || name !== `tag ${squashTagName(request.squash)}` || !message.startsWith(expected)) {
    throw new Error('factory: the tag does not bind the approved squash.');
  }
  return tag;
}

function publishSquashEvidence(git, origin, tag, { squash, head }) {
  const refs = [squashTagRef(squash), reviewedHeadRef(squash)];
  const expected = [`${tag}\t${refs[0]}`, `${head}\t${refs[1]}`].sort().join('\n');
  const readback = () => git(['ls-remote', '--refs', origin, ...refs]).split('\n').sort().join('\n');
  const observed = readback();
  if (observed === expected) return;
  if (observed) throw new Error('factory: squash evidence refs are partial or conflicting.');
  git(['-c', 'push.followTags=false', '-c', 'push.pushOption=', 'push', '--atomic', '--quiet', '--recurse-submodules=no',
    ...refs.map(ref => `--force-with-lease=${ref}:`), origin,
    `${tag}:${refs[0]}`, `${head}:${refs[1]}`]);
  if (readback() !== expected) throw new Error('factory: squash evidence readback differs from the saved receipt.');
}

function requireCandidate(git, commit, { base, tree }) {
  const shape = git(['show', '--no-patch', '--format=%P%n%T', commit]).split('\n');
  if (shape[0] !== base || shape[1] !== tree) throw new Error('factory: the candidate must have only the checked base as its parent and the checked tree.');
}

export function releaseGit(directory, origin) {
  const git = (arguments_, options) => command('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-C', directory, ...arguments_], options);
  return {
    tip(ref) {
      const [commit, observed] = git(['ls-remote', '--refs', '--exit-code', origin, ref]).split('\t');
      if (observed !== ref) throw new Error(`factory: could not establish the remote tip of ${ref}.`);
      return commit;
    },
    tree(commit) {
      return git(['rev-parse', '--verify', `${commit}^{tree}`]);
    },
    store(release) {
      return git(['hash-object', '-w', '-t', 'commit', '--stdin'], { input: Buffer.from(release.object, 'base64') });
    },
    requireCandidate: (commit, request) => requireCandidate(git, commit, request),
    requireLandedSquash(commit, request) {
      const [tip, ref] = git(['ls-remote', '--refs', '--exit-code', origin, request.ref]).split('\t');
      if (ref !== request.ref || !/^[a-f0-9]{40}$/.test(tip)) throw new Error('factory: could not establish the squash target tip.');
      git(['fetch', '--no-tags', '--no-write-fetch-head', origin, tip]);
      requireCandidate(git, commit, request);
      const history = git(['rev-list', '--first-parent', tip, `^${request.base}`]).split('\n');
      if (!history.includes(commit)) throw new Error('factory: the squash is outside the target first-parent history.');
    },
    storeSquashEvidence: (release, request) => storeSquashEvidence(git, release, request),
    publishSquashEvidence: (tag, request) => publishSquashEvidence(git, origin, tag, request),
    publish(commit, { ref, base, head }) {
      const evidence = reviewedHeadRef(commit);
      git(['push', '--atomic', '--quiet', `--force-with-lease=${ref}:${base}`, `--force-with-lease=${evidence}:`, origin, `${commit}:${ref}`, `${head}:${evidence}`]);
    },
    requireReviewedHead(commit, head) {
      const evidence = reviewedHeadRef(commit);
      const [observed] = git(['ls-remote', '--refs', origin, evidence]).split('\t');
      if (observed !== head) throw new Error(`factory: ${evidence} must retain reviewed head ${head}.`);
    },
  };
}
