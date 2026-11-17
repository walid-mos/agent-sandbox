import { REPOSITORY, utcDay } from './pr-board-contract.mjs';
import { command } from './run.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const TIMEOUT_MS = 30_000;

export function githubPulls(repository, now, run = command) {
  if (!REPOSITORY.test(repository)) throw new Error('pr-board: invalid GitHub repository.');
  const query = (state, page) => {
    try {
      const result = JSON.parse(run('gh', ['api', `repos/${repository}/pulls?state=${state}&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`], { timeout: TIMEOUT_MS }));
      if (!Array.isArray(result) || result.length > PAGE_SIZE) throw new Error();
      return result;
    } catch {
      throw new Error('pr-board: GitHub pull request read failed.');
    }
  };
  function pages(state) {
    const pulls = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = query(state, page);
      pulls.push(...batch);
      const hasOlder = state === 'closed' && batch.some(pull => Date.parse(pull.updated_at) < Date.parse(`${utcDay(now)}T00:00:00Z`));
      if (batch.length < PAGE_SIZE || hasOlder) return pulls;
    }
    throw new Error('pr-board: GitHub pagination limit reached. No partial snapshot was published.');
  }
  return [...pages('open'), ...pages('closed').filter(pull => pull.merged_at && utcDay(Date.parse(pull.merged_at)) === utcDay(now))];
}
