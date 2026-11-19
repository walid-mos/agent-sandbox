import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function pushHead(worker, head, options, pushOptions = [], configuration = []) {
  const objects = command('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: worker.worktree });
  command('git', ['-c', 'credential.helper=!gh auth git-credential', '-c', 'http.followRedirects=false', ...configuration,
    'push', '--quiet', ...pushOptions, '--', worker.originUrl, `${head}:refs/heads/${worker.branch}`],
  { ...options, env: { ...options.env, GIT_OBJECT_DIRECTORY: objects } });
}

export function pushApproved(worker, head) {
  return isolatedGit(options => pushHead(worker, head, options, [`--force-with-lease=refs/heads/${worker.branch}:`]));
}

const VERIFY_ADVERTISED_REF = `#!/bin/sh
set -eu
read -r local_ref local_oid remote_ref remote_oid
if [ "$remote_oid" != "$POTS_EXPECTED_REMOTE_HEAD" ] || [ "$remote_ref" != "$POTS_EXPECTED_REMOTE_REF" ] || read -r extra; then
  printf '%s\\n' 'dispatch: remote branch changed since PR verification. Inspect it before pushing.' >&2
  exit 1
fi
`;

export function pushExisting(worker, head, expectedHead) {
  return isolatedGit(options => {
    writeFileSync(join(options.cwd, 'pre-push'), VERIFY_ADVERTISED_REF, { mode: 0o700 });
    const env = { ...options.env, POTS_EXPECTED_REMOTE_HEAD: expectedHead, POTS_EXPECTED_REMOTE_REF: `refs/heads/${worker.branch}` };
    pushHead(worker, head, { ...options, env }, [], ['-c', `core.hooksPath=${options.cwd}`]);
  });
}
