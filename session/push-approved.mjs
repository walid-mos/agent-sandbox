import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './run.mjs';

export function pushApproved(worker, head) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-first-push-'));
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const env = { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const options = { cwd: directory, env };
    command('git', ['init', '--quiet', '--bare', '--template=', directory], options);
    const objects = command('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: worker.worktree });
    command('git', ['-c', 'credential.helper=!gh auth git-credential', 'push', '--quiet',
      `--force-with-lease=refs/heads/${worker.branch}:`, '--', worker.originUrl, `${head}:refs/heads/${worker.branch}`],
    { ...options, env: { ...env, GIT_OBJECT_DIRECTORY: objects } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
