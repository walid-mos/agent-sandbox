import { spawnSync } from 'node:child_process';
import { answerCredentialRequest } from './git-credential.mjs';
import { main } from './main.mjs';
import { owners, sandbox } from './sandbox.mjs';

const TOKEN_NAMES = Object.fromEntries(Object.entries(sandbox.owners).map(([owner, name]) => [owner.toLowerCase(), name]));
const GITHUB_URL = /^https:\/\/github\.com\//;
const [operation, ...arguments_] = process.argv.slice(2);

function tokenFor(repository) {
  const owner = repository.replace(GITHUB_URL, '').split('/')[0]?.toLowerCase();
  const name = TOKEN_NAMES[owner];
  if (!name) throw new Error(`github: specify a repository owned by ${owners.join(' or ')}`);
  const token = process.env[name];
  if (!token) throw new Error(`github: ${name} is not in the environment. Run this through with-vault.`);
  return token;
}

function checkoutRepository() {
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return origin.status === 0 ? origin.stdout.trim().replace(/^git@github\.com:/, '') : '';
}

function selectedRepository(ghArguments) {
  const position = ghArguments.findIndex(value => value === '--repo' || value === '-R');
  if (position >= 0) return ghArguments[position + 1] ?? '';
  const explicit = ghArguments.find(value => value.startsWith('--repo='));
  if (explicit) return explicit.slice('--repo='.length);
  const endpoint = ghArguments.find(value => /^\/?repos\//.test(value));
  if (endpoint) return endpoint.replace(/^\/?repos\//, '');
  if (process.env.GH_REPO) return process.env.GH_REPO;
  // A URL argument ranks last: it can be the text of a --body as well as the repository gh acts on.
  return checkoutRepository() || ghArguments.find(value => GITHUB_URL.test(value)) || '';
}

function gh([executable, ...ghArguments]) {
  const token = tokenFor(selectedRepository(ghArguments));
  const child = spawnSync(executable, ghArguments, { stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } });
  if (child.error) throw new Error('github: could not launch the installed gh binary', { cause: child.error });
  process.exitCode = child.status ?? 1;
}

main(import.meta, () => {
  if (operation === 'credential') answerCredentialRequest(arguments_[0], tokenFor);
  else if (operation === 'gh') gh(arguments_);
  else throw new Error('github: expected credential or gh');
});
