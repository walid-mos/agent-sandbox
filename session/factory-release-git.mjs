import { command } from './run.mjs';

const reviewedHeadRef = commit => `refs/tags/factory-reviewed/${commit}`;

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
    requireCandidate(commit, { base, tree }) {
      const shape = git(['show', '--no-patch', '--format=%P%n%T', commit]).split('\n');
      if (shape[0] !== base || shape[1] !== tree) throw new Error('factory: the candidate must have only the checked base as its parent and the checked tree.');
    },
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
