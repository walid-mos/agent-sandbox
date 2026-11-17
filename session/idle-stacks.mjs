import { sep } from 'node:path';
import { idleStackMinutes } from './limits.mjs';
import { command } from './run.mjs';

const MINUTE_MS = 60_000;
const PROJECT_LABEL = 'com.docker.compose.project';
const FOLDER_LABEL = 'com.docker.compose.project.working_dir';
// Compose finds a stopped project by its labels, and a compose file in the folder it runs from would claim the name.
const OUTSIDE_ANY_PROJECT = '/';
const idleSince = new Map();
const stopped = new Set();

const isInside = (path, folder) => path === folder || path.startsWith(`${folder}${sep}`);

function idleDeadline(worktree, terminals, now) {
  if (terminals.some(terminal => isInside(terminal.cwd ?? '', worktree))) {
    idleSince.delete(worktree);
    stopped.delete(worktree);
    return undefined;
  }
  if (stopped.has(worktree)) return undefined;
  if (!idleSince.has(worktree)) idleSince.set(worktree, now);
  return idleSince.get(worktree) + idleStackMinutes * MINUTE_MS;
}

function runningProjects() {
  return command('docker', ['ps', '--format', `{{.Label "${PROJECT_LABEL}"}}\t{{.Label "${FOLDER_LABEL}"}}`])
    .split('\n').filter(Boolean).map(row => row.split('\t')).filter(([project]) => project);
}

function stopStacks(worktree, projects) {
  const own = new Set(projects.filter(([, folder]) => isInside(folder, worktree)).map(([project]) => project));
  own.forEach(project => {
    command('docker', ['compose', '-p', project, 'stop'], { cwd: OUTSIDE_ANY_PROJECT });
    process.stdout.write(`pots-watcher: stopped Compose project ${project} of ${worktree}, idle for ${idleStackMinutes} minutes\n`);
  });
  stopped.add(worktree);
}

// A failed look tries again after another idle period, so a Docker daemon that is down never makes the watcher spin.
function stopDue(worktrees, now, logFailure) {
  try {
    const projects = runningProjects();
    worktrees.forEach(worktree => stopStacks(worktree, projects));
  } catch (error) {
    logFailure('idle stacks', error);
    worktrees.filter(worktree => !stopped.has(worktree)).forEach(worktree => idleSince.set(worktree, now));
  }
}

/** Stops the Compose projects of each worktree no live terminal has used for idleStackMinutes, and resolves to the next time one falls due. */
export function stopIdleStacks(worktrees, terminals, logFailure) {
  const now = Date.now();
  const known = new Set(worktrees);
  const deadlines = [...known].map(worktree => [worktree, idleDeadline(worktree, terminals, now)]);
  const due = deadlines.filter(([, at]) => at !== undefined && at <= now).map(([worktree]) => worktree);
  if (due.length > 0) stopDue(due, now, logFailure);
  const pending = [...idleSince].filter(([worktree]) => known.has(worktree) && !stopped.has(worktree));
  return pending.length > 0 ? Math.min(...pending.map(([, since]) => since + idleStackMinutes * MINUTE_MS)) : undefined;
}
