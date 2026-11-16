import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_SNAPSHOT = '/work/home/shellcheck-base';
const SHELL_LINE = /^#!\s*(\/bin\/(ba)?sh|\/usr\/bin\/env\s+(ba)?sh)(\s|$)/;
const SHELLCHECK_FOUND_ISSUES = 1;

const git = arguments_ => execFileSync('git', arguments_, { encoding: 'utf8' });
const firstLine = path => readFileSync(path, 'utf8').split('\n', 1)[0];
const isShell = path => path.endsWith('.sh') || SHELL_LINE.test(firstLine(path));

function findings(root, files) {
  const present = files.filter(file => existsSync(join(root, file)));
  if (present.length === 0) return [];
  const run = spawnSync('shellcheck', ['--format', 'json1', '--severity', 'warning', ...present], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0 && run.status !== SHELLCHECK_FOUND_ISSUES) throw new Error(`shellcheck failed: ${run.stderr}`);
  return JSON.parse(run.stdout).comments.map(finding => {
    const text = readFileSync(join(root, finding.file), 'utf8').split('\n')[finding.line - 1]?.trim();
    return { ...finding, key: `${finding.file}\t${finding.code}\t${text}` };
  });
}

function added(headFindings, baseFindings) {
  const remaining = new Map();
  for (const { key } of baseFindings) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  return headFindings.filter(({ key }) => {
    const count = remaining.get(key) ?? 0;
    remaining.set(key, count - 1);
    return count <= 0;
  });
}

function requireBase(base) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('usage: shellcheck-new BASE_SHA');
  return base;
}

function print(introduced, changedCount) {
  for (const finding of introduced) {
    process.stdout.write(`${finding.file}:${finding.line}:${finding.column}: ${finding.level} SC${finding.code}: ${finding.message}\n`);
  }
  process.stdout.write(`shellcheck: ${changedCount} changed shell files, ${introduced.length} new findings\n`);
}

function report(candidate) {
  const base = requireBase(candidate);
  const changed = git(['diff', '--name-only', '--diff-filter=AMR', base, 'HEAD']).split('\n').filter(Boolean).filter(isShell);
  git(['worktree', 'add', '--quiet', '--detach', BASE_SNAPSHOT, base]);
  const introduced = added(findings('.', changed), findings(BASE_SNAPSHOT, changed));
  print(introduced, changed.length);
  process.exitCode = introduced.length > 0 ? 1 : 0;
}

if (import.meta.main) report(process.argv[2]);
