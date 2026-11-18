import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './run.mjs';

function gitEnvironment() {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}

function isolatedGit(operation) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-first-push-'));
  try {
    const options = { cwd: directory, env: gitEnvironment() };
    command('git', ['init', '--quiet', '--bare', '--template=', directory], options);
    return operation(options);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const isFullObjectId = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

export function remoteHead(worker) {
  const expectedRef = `refs/heads/${worker.branch}`;
  const output = isolatedGit(options => command('git', ['-c', 'credential.helper=!gh auth git-credential', '-c', 'http.followRedirects=false',
    'ls-remote', '--refs', '--heads', '--', worker.originUrl, expectedRef], options));
  if (!output) return '';
  const [oid, ref, extra] = output.split('\t');
  if (!isFullObjectId(oid) || ref !== expectedRef || extra !== undefined) {
    throw new Error('dispatch: authoritative remote readback was malformed. Stop and inspect the destination.');
  }
  return oid;
}

export function pushApproved(worker, head) {
  return isolatedGit(options => {
    const objects = command('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: worker.worktree });
    command('git', ['-c', 'credential.helper=!gh auth git-credential', 'push', '--quiet',
      `--force-with-lease=refs/heads/${worker.branch}:`, '--', worker.originUrl, `${head}:refs/heads/${worker.branch}`],
    { ...options, env: { ...options.env, GIT_OBJECT_DIRECTORY: objects } });
  });
}
