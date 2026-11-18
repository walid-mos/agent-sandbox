import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { sandboxFixture } from './sandbox.mjs';

const gitHome = process.env.HOME;
export const { home, sandbox } = sandboxFixture('worker-publication-');
const { command: realCommand, ...realRun } = await import('../../session/run.mjs');
export const github = [];
export const githubState = { canCreatePR: true, failPRHead: undefined, pullRequests: [], pushAttempts: 0, afterPush: undefined, beforePush: undefined, readback: undefined };
mock.module('../../session/run.mjs', { exports: { ...realRun, WITH_VAULT: '/unused', command(binary, args, options) {
  if (binary !== 'gh') {
    const localOrigin = githubState.localOrigin;
    if (binary === 'git' && localOrigin) {
      if (options?.cwd === localOrigin.checkout && args[0] === 'remote' && args[1] === 'get-url') return localOrigin.url;
      args = args.map(arg => arg === localOrigin.url ? localOrigin.remote : arg);
    }
    if (binary === 'git' && args.includes('ls-remote') && args.includes(githubState.readback?.url)
      && githubState.pushAttempts >= githubState.readback.afterPush) {
      const { respond } = githubState.readback;
      githubState.readback = undefined;
      return respond();
    }
    if (binary === 'git' && args.includes('push')) {
      githubState.pushAttempts += 1;
      if (githubState.beforePush?.url === args.at(-2)) githubState.beforePush.action();
      const result = realCommand(binary, args, { ...options, env: { ...process.env, ...options?.env, HOME: gitHome } });
      if (githubState.afterPush?.url === args.at(-2)) githubState.afterPush.action();
      return result;
    }
    return realCommand(binary, args, { ...options, env: { ...process.env, ...options?.env, HOME: gitHome } });
  }
  github.push(args);
  if (args[0] === 'api' && githubState.respond) return JSON.stringify(githubState.respond(args));
  if (args[1] === 'create' && (!githubState.canCreatePR || args.includes(githubState.failPRHead))) throw new Error('GitHub temporarily unavailable');
  if (args[1] === 'list') return JSON.stringify(githubState.pullRequests);
  return 'https://github.invalid/proof/repository/pull/1';
} } });
export const { save, workers } = await import('../../session/workers.mjs');
export const { humanStore } = await import('../../session/human-store.mjs');
export const { workerScope, publishWorker, openWorkerPR, pushWorker } = await import('../../session/worker-publication.mjs');
export const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=probe', '-c', 'user.email=probe@invalid', '-c', 'commit.gpgsign=false', ...args,
], { cwd, env: { ...process.env, HOME: gitHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let sequence = 0;

export function fixture({ publicationPolicy } = {}) {
  const folder = join(home, `run-${++sequence}`);
  mkdirSync(folder);
  const remote = join(folder, 'origin.git');
  const checkout = join(folder, 'checkout');
  git(folder, 'init', '--bare', remote);
  git(folder, 'init', '-b', 'main', checkout);
  writeFileSync(join(checkout, 'base'), 'base\n');
  git(checkout, 'add', 'base');
  git(checkout, 'commit', '-m', 'test: base');
  git(checkout, 'remote', 'add', 'origin', remote);
  git(checkout, 'push', 'origin', 'main');
  git(checkout, 'checkout', '-b', 'feat/probe');
  if (!publicationPolicy) git(checkout, 'commit', '--allow-empty', '-m', 'feat: bootstrap');
  const worker = { name: `proof-${sequence}`, kind: 'repository', owner: 'proof', repository: 'proof/repository',
    branch: 'feat/probe', base: 'main', title: 'feat: probe', worktree: checkout, originUrl: remote, publication: 'local', publicationPolicy };
  save(worker);
  return { worker, remote, checkout };
}

export const { approval, IDENTITY, OPTIONS, CLICK } = await import('./worker-publication-approval.mjs');
sandbox.humanDiscord = IDENTITY;

export const remoteHeads = f => git(f.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/feat/probe');
