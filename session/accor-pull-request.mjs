import { isFullObjectId } from './push-approved.mjs';
import { command } from './run.mjs';
import { recordPublication } from './workers.mjs';

function pulls(worker, args = [], suffix = '') {
  return JSON.parse(command('gh', ['api', `repos/${worker.repository}/pulls${suffix}`, '--hostname', 'github.com', ...args]));
}

function pullUrl(worker, number) {
  return `https://github.com/${worker.repository}/pull/${number}`;
}

function matchesPull(worker, pull) {
  return pull?.state === 'open' && Number.isSafeInteger(pull.number) && pull.number > 0
    && pull.html_url === pullUrl(worker, pull.number) && pull.head?.repo?.full_name === worker.repository
    && pull.base?.repo?.full_name === worker.repository && pull.head.ref === worker.branch
    && Boolean(pull.base.ref) && (!worker.base || pull.base.ref === worker.base) && isFullObjectId(pull.head.sha);
}

export function verifyPublishedPR(worker, remoteHead) {
  const number = worker.pullRequest?.split('/').at(-1) ?? '';
  if (!/^[1-9][0-9]*$/.test(number) || worker.pullRequest !== pullUrl(worker, number)) {
    throw new Error('dispatch: no recorded PR URL in the worker repository. Inspect publication before pushing.');
  }
  const pull = pulls(worker, [], `/${number}`);
  if (!matchesPull(worker, pull) || pull.html_url !== worker.pullRequest || pull.head.sha !== remoteHead) {
    throw new Error('dispatch: the recorded PR is not open on the expected repository, branch and remote head. Inspect publication before pushing.');
  }
  return pull.html_url;
}

export function openReadyPR(worker, verifyHead) {
  const owner = worker.repository.split('/')[0];
  const candidates = pulls(worker, ['--method', 'GET', '-f', `head=${owner}:${worker.branch}`, '-f', 'state=all']);
  if (!Array.isArray(candidates) || candidates.length > 1) throw new Error('dispatch: GitHub did not return an unambiguous PR for the approved branch. Inspect it before retrying.');
  const [existing] = candidates;
  verifyHead();
  if (!existing && worker.prCreationAttempted) throw new Error('dispatch: PR creation was attempted but GitHub has not confirmed it. Inspect GitHub before proceeding.');
  if (!existing) recordPublication(worker, { prCreationAttempted: true });
  const pull = existing ?? pulls(worker, ['--method', 'POST', '-f', `head=${worker.branch}`, '-f', `base=${worker.base}`,
    '-f', `title=${worker.title}`, '-F', 'draft=false']);
  if (!matchesPull(worker, pull) || pull.draft !== false || pull.head.sha !== worker.publishedHead || pull.title !== worker.title) {
    throw new Error('dispatch: GitHub did not confirm an open ready PR for the exact approved head, refs and title. Inspect the PR before proceeding.');
  }
  verifyHead();
  return pull.html_url;
}
