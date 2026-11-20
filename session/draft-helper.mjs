import { homedir } from 'node:os';
import { join } from 'node:path';
import { command } from './run.mjs';

export const DRAFT_PR = join(homedir(), '.pi/agent/skills/worktree/scripts/draft-pr');

// The installed helper prints its usage when it gets no argument. Without --description there it would ignore a body and open an empty draft.
function helperUsage() {
  try {
    return command('bash', [DRAFT_PR], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

export const draftHelperTakesDescription = () => helperUsage().includes('--description');

export function requireDraftHelper() {
  if (draftHelperTakesDescription()) return;
  throw new Error('dispatch: the installed draft-pr helper does not take --description, so a draft would open with no body. Install the Pi harness that ships it, then try again.');
}

// One dead pair must not stop work that owes no draft: a worker with its PR already, or an Accor worker that opens a ready PR through the API.
export const owesDraft = worker => Boolean(worker.repository) && worker.kind !== 'task' && !worker.pullRequest
  && worker.publication !== 'published' && !worker.publicationPolicy;

export function requireDraftHelperFor(worker) {
  if (owesDraft(worker)) requireDraftHelper();
}
