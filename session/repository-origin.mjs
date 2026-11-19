import { command } from './run.mjs';

export function repositoryOrigin(repository, checkout) {
  const origin = command('git', ['remote', 'get-url', 'origin'], { cwd: checkout });
  const urls = [`https://github.com/${repository}`, `git@github.com:${repository}`, `ssh://git@github.com/${repository}`];
  if (!urls.some(url => origin === url || origin === `${url}.git`)) throw new Error(`dispatch: checkout origin does not match ${repository}. Restore it before continuing.`);
  return origin;
}
