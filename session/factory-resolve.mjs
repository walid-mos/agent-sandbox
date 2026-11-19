import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireActionable } from './factory-github.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { branchTip, copyAt, refreshMirror, remoteUrl } from './factory-mirror.mjs';
import { pullArguments, pullUrl, pullWorkspace, requireRecord, withRecord } from './factory-records.mjs';
import { command } from './run.mjs';

const CONFLICT_MARKER = '^(<<<<<<<|>>>>>>>) ';

const git = (workspace, arguments_) => command('git', ['-C', workspace, ...arguments_]);
const unmergedPaths = workspace => git(workspace, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);

function startMerge(workspace, baseTip) {
  spawnSync('git', ['-C', workspace, 'merge', '--no-ff', '--no-edit', baseTip], { stdio: 'ignore' });
  return unmergedPaths(workspace);
}

export function resolve(arguments_) {
  const pull = pullArguments(arguments_);
  return withRecord(pull, (_, save) => prepareResolution(pull, save));
}

function prepareResolution(pull, save) {
  const record = requireRecord(pull, 'conflict');
  const facts = requireActionable(record);
  if (facts.isCrossRepository) throw new Error(`factory: ${pullUrl(pull)} comes from a fork, where the factory cannot push. Escalate it.`);
  refreshMirror(pull.repository);
  const baseTip = branchTip(pull.repository, facts.baseRefName);
  requireReviewBase(record, baseTip);
  const workspace = pullWorkspace('resolutions', pull);
  rmSync(workspace, { recursive: true, force: true });
  copyAt(pull.repository, pull.head, workspace);
  git(workspace, ['checkout', '--quiet', '-B', facts.headRefName]);
  git(workspace, ['remote', 'set-url', 'origin', remoteUrl(pull.repository)]);
  const files = startMerge(workspace, baseTip);
  save({ ...record, resolution: { workspace, branch: facts.headRefName, baseTip, files } });
  process.stdout.write(`${workspace}\nMerging ${facts.baseRefName} at ${baseTip} into ${facts.headRefName} left ${files.length} conflicted files:\n${files.join('\n')}\n`);
}

function requireReviewBase(record, baseTip) {
  if (isDurableFactory && baseTip !== record.baseTip) throw new Error('factory: the base moved since this review, wait for the next wake');
}

function requireCommittedMerge(workspace) {
  if (existsSync(join(workspace, '.git/MERGE_HEAD')) || unmergedPaths(workspace).length > 0) {
    throw new Error('factory: the merge is not committed. Resolve every conflicted file, git add them, then git commit --no-edit.');
  }
}

function resolvedCommit(workspace, { head, baseTip, files }) {
  requireCommittedMerge(workspace);
  const [commit, ...parents] = git(workspace, ['rev-list', '--parents', '--max-count=1', 'HEAD']).split(' ');
  if (parents.join(' ') !== `${head} ${baseTip}`) throw new Error(`factory: HEAD must be one merge commit of ${head} and ${baseTip}. Run resolve again.`);
  requireNoMarkers(workspace, files);
  return commit;
}

function requireNoMarkers(workspace, files) {
  if (files.length === 0) return;
  const markers = spawnSync('git', ['-C', workspace, 'grep', '--line-number', '-E', CONFLICT_MARKER, 'HEAD', '--', ...files], { encoding: 'utf8' });
  if (markers.status === 0) throw new Error(`factory: conflict markers are left:\n${markers.stdout}`);
  if (markers.status !== 1) throw new Error('factory: Git could not check for conflict markers.');
}

// A plain push: GitHub rejects it when the branch moved, so the factory never overwrites a commit it did not see.
export function push(arguments_) {
  const pull = pullArguments(arguments_);
  return withRecord(pull, (_, save) => pushResolution(pull, save));
}

function pushResolution(pull, save) {
  const record = requireRecord(pull, 'conflict');
  if (!record.resolution) throw new Error(`factory: ${pullUrl(pull)} has no resolution under way. Run resolve first.`);
  const { workspace, branch } = record.resolution;
  const commit = resolvedCommit(workspace, { head: pull.head, ...record.resolution });
  requireActionable(record);
  git(workspace, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  save({ ...record, stage: 'resolved', resolution: { ...record.resolution, commit } });
  rmSync(workspace, { recursive: true, force: true });
  process.stdout.write(`factory: pushed ${commit} to ${branch}. The next scan checks it as a new head.\n`);
}
