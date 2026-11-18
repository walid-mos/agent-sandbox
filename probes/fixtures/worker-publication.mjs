import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { sandboxFixture } from './sandbox.mjs';

const gitHome = process.env.HOME;
export const { home } = sandboxFixture('worker-publication-');
const { command: realCommand, ...realRun } = await import('../../session/run.mjs');
export const github = [];
export const githubState = { canCreatePR: true, pullRequests: [] };
mock.module('../../session/run.mjs', { exports: { ...realRun, WITH_VAULT: '/unused', command(binary, args, options) {
  if (binary !== 'gh') {
    if (binary === 'git' && args.includes('push')) githubState.beforePush?.();
    return realCommand(binary, args, { ...options, env: { ...process.env, ...options?.env, HOME: gitHome } });
  }
  github.push(args);
  if (args[1] === 'create' && !githubState.canCreatePR) throw new Error('GitHub temporarily unavailable');
  if (args[1] === 'list') return JSON.stringify(githubState.pullRequests);
  return 'https://github.invalid/proof/repository/pull/1';
} } });
export const { save, workers } = await import('../../session/workers.mjs');
const { openDialog, questionDigest } = await import('../../session/human-dialogs.mjs');
export const { humanStore } = await import('../../session/human-store.mjs');
export const { workerScope, publishWorker, openWorkerPR } = await import('../../session/worker-publication.mjs');
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, HOME: gitHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let sequence = 0;

export function fixture() {
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
  git(checkout, 'commit', '--allow-empty', '-m', 'feat: bootstrap');
  const worker = { name: `proof-${sequence}`, kind: 'repository', owner: 'proof', repository: 'proof/repository',
    branch: 'feat/probe', base: 'main', title: 'feat: probe', worktree: checkout, originUrl: remote, publication: 'local' };
  save(worker);
  return { worker, remote, checkout };
}

// The proof path stays in the Discord probe suite with checked registration. This helper fills one synthetic
// registered receipt so the Git-focused tests never route through a terminal answer, which publication forbids.
export const SYNTHETIC = { operator: '10000000000000001', guild: '10000000000000003', channel: '10000000000000004', message: '10000000000000005' };
const SYNTHETIC_URL = `https://discord.com/channels/${SYNTHETIC.guild}/${SYNTHETIC.channel}/${SYNTHETIC.message}`;
const SYNTHETIC_DOOR = 'mastermind.1234567890abcdef';

export async function approval(scope, label = 'Push once', shouldAnswer = true) {
  const dialog = await openDialog({ kind: 'question', source: { type: 'bot', message: `approval-${++sequence}` }, policy: 'push', scope,
    questions: [{ id: 'push', prompt: 'Publish these exact commits?', options: [{ label: 'Push once' }, { label: 'Keep local' }] }] });
  if (shouldAnswer) {
    const digest = questionDigest(dialog);
    const result = { status: 'answered', origin: 'discord', at: Date.now(), messageId: SYNTHETIC_URL, dialog: dialog.id, request: SYNTHETIC_DOOR,
      digest, scope, answers: [{ id: 'push', labels: [label], text: '' }],
      evidence: { door: SYNTHETIC_DOOR, clicks: [{ question: 'push', userId: SYNTHETIC.operator, guildId: SYNTHETIC.guild, messageUrl: SYNTHETIC_URL, at: '2026-01-01T00:00:00Z' }] } };
    const staged = { identity: { pushApprovalsEnabled: true, userId: SYNTHETIC.operator },
      door: { pot: 'mastermind', direction: 'asked', id: SYNTHETIC_DOOR, state: 'answered' },
      reply: { type: 'human.answer', version: 1, dialog: dialog.id, request: SYNTHETIC_DOOR, digest, answers: result.answers,
        clicks: [{ question: 'push', userId: SYNTHETIC.operator, guildId: SYNTHETIC.guild, messageUrl: SYNTHETIC_URL, at: '2026-01-01T00:00:00Z' }] } };
    await humanStore().patch(dialog.id, { delivery: { id: SYNTHETIC_DOOR }, result, staged,
      posted: { request: SYNTHETIC_DOOR, digest, guildId: SYNTHETIC.guild, messages: [{ question: 'push', messageUrl: SYNTHETIC_URL }] } });
  }
  return dialog.id;
}

export const remoteHeads = f => git(f.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/feat/probe');
