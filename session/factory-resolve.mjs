import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireActionable } from './factory-github.mjs';
import { branchTip, copyAt, refreshMirror, remoteUrl } from './factory-mirror.mjs';
import { FACTORY_HOME, pullArguments, pullKey, pullUrl, requireRecord, writeRecord } from './factory-records.mjs';
import { command } from './run.mjs';

const RESOLUTIONS = join(FACTORY_HOME, 'resolutions');
const CONFLICT_MARKER = '^(<<<<<<<|>>>>>>>) ';

const git = (workspace, arguments_) => command('git', ['-C', workspace, ...arguments_]);
const unmergedPaths = workspace => git(workspace, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);

function startMerge(workspace, base) {
  spawnSync('git', ['-C', workspace, 'merge', '--no-ff', '--no-edit', `origin/${base}`], { stdio: 'ignore' });
  return unmergedPaths(workspace);
}

export function resolve(arguments_) {
  const pull = pullArguments(arguments_);
  const record = requireRecord(pull, 'conflict');
  const facts = requireActionable(pull);
  if (facts.isCrossRepository) throw new Error(`factory: ${pullUrl(pull)} comes from a fork, where the factory cannot push. Escalate it.`);
  refreshMirror(pull.repository);
  const workspace = join(RESOLUTIONS, pullKey(pull));
  rmSync(workspace, { recursive: true, force: true });
  copyAt(pull.repository, pull.head, workspace);
  git(workspace, ['checkout', '--quiet', '-B', facts.headRefName]);
  git(workspace, ['remote', 'set-url', 'origin', remoteUrl(pull.repository)]);
  const baseTip = branchTip(pull.repository, facts.baseRefName);
  const files = startMerge(workspace, facts.baseRefName);
  writeRecord({ ...record, resolution: { workspace, branch: facts.headRefName, baseTip, files } });
  process.stdout.write(`${workspace}\nMerging ${facts.baseRefName} at ${baseTip} into ${facts.headRefName} left ${files.length} conflicted files:\n${files.join('\n')}\n`);
}

function resolvedCommit(workspace, { head, baseTip, files }) {
  if (existsSync(join(workspace, '.git/MERGE_HEAD')) || unmergedPaths(workspace).length > 0) {
    throw new Error('factory: the merge is not committed. Resolve every conflicted file, git add them, then git commit --no-edit.');
  }
  const [commit, ...parents] = git(workspace, ['rev-list', '--parents', '--max-count=1', 'HEAD']).split(' ');
  if (parents.join(' ') !== `${head} ${baseTip}`) throw new Error(`factory: HEAD must be one merge commit of ${head} and ${baseTip}. Run resolve again.`);
  const markers = spawnSync('git', ['-C', workspace, 'grep', '--line-number', '-E', CONFLICT_MARKER, 'HEAD', '--', ...files], { encoding: 'utf8' });
  if (files.length > 0 && markers.status === 0) throw new Error(`factory: conflict markers are left:\n${markers.stdout}`);
  return commit;
}

// A plain push: GitHub rejects it when the branch moved, so the factory never overwrites a commit it did not see.
export function push(arguments_) {
  const pull = pullArguments(arguments_);
  const record = requireRecord(pull, 'conflict');
  if (!record.resolution) throw new Error(`factory: ${pullUrl(pull)} has no resolution under way. Run resolve first.`);
  const { workspace, branch } = record.resolution;
  const commit = resolvedCommit(workspace, { head: pull.head, ...record.resolution });
  requireActionable(pull);
  git(workspace, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  writeRecord({ ...record, stage: 'resolved', resolution: { ...record.resolution, commit } });
  rmSync(workspace, { recursive: true, force: true });
  process.stdout.write(`factory: pushed ${commit} to ${branch}. The next scan checks it as a new head.\n`);
}
