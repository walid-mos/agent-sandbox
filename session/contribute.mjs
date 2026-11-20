import { lstatSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { githubApi } from './contribution-api.mjs';
import { contributionOperations } from './contribution-operations.mjs';
import { contributionPolicy, grantFor } from './contribution-policy.mjs';
import { basicEnvironment, RUNTIME_SETTINGS } from './environment.mjs';
import { main } from './main.mjs';
import { pushApproved, pushExisting } from './push-approved.mjs';
import { command } from './run.mjs';
import { sandbox } from './sandbox.mjs';

const USAGE = `usage: contribute check UPSTREAM
       contribute fork UPSTREAM [--dry-run]
       contribute issue UPSTREAM --title TITLE --body-file FILE [--dry-run]
       contribute push UPSTREAM --branch BRANCH --commit COMMIT [--expect REMOTE_COMMIT] [--worktree DIRECTORY] [--dry-run]
       contribute pull-request UPSTREAM --branch BRANCH --commit COMMIT --title TITLE --body-file FILE [--dry-run]`;
const OPTIONS = {
  check: [],
  fork: ['dry-run'],
  issue: ['dry-run', 'title', 'body-file'],
  push: ['dry-run', 'branch', 'commit', 'expect', 'worktree'],
  'pull-request': ['dry-run', 'branch', 'commit', 'title', 'body-file'],
};
const PARSER_OPTIONS = {
  'dry-run': { type: 'boolean' },
  ...Object.fromEntries(['title', 'body-file', 'branch', 'commit', 'expect', 'worktree'].map(name => [name, { type: 'string' }])),
};
const MAX_BODY_FILE_BYTES = 65_536;
const TOKEN_VARIABLE = 'POTS_CONTRIBUTION_TOKEN';
const usageError = message => Object.assign(new Error(`contribute: ${message}\n${USAGE}`), { exitCode: 2 });

function parsedArguments(arguments_) {
  const [operation, upstream, ...rest] = arguments_;
  if (!Object.hasOwn(OPTIONS, operation) || !upstream) throw usageError('expected an operation and an upstream repository.');
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: PARSER_OPTIONS, allowPositionals: false, strict: true }));
  } catch (error) {
    throw usageError(error.message);
  }
  const unsupported = Object.keys(values).filter(name => !OPTIONS[operation].includes(name));
  if (unsupported.length) throw usageError(`${operation} does not take --${unsupported.join(' or --')}.`);
  return { operation, upstream, values };
}

function bodyFrom(path) {
  if (!path) throw usageError('--body-file is required.');
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (!status?.isFile() || status.size > MAX_BODY_FILE_BYTES) throw usageError(`${path} must be a regular file up to ${MAX_BODY_FILE_BYTES} bytes.`);
  return readFileSync(path, 'utf8');
}

function localGit(worktree, arguments_) {
  const environment = { ...basicEnvironment(process.env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  return command('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...arguments_], { cwd: worktree, env: environment });
}

function gitFor(token) {
  const access = { helper: `!f() { printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_VARIABLE}"; }; f`, env: { [TOKEN_VARIABLE]: token } };
  return {
    branchHead: (worktree, branch) => localGit(worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]),
    pushNew: (destination, commit) => pushApproved(destination, commit, access),
    pushUpdate: (destination, commit, expected) => pushExisting(destination, commit, expected, access),
  };
}

function inputsFor(operation, values) {
  const dryRun = values['dry-run'] === true;
  const text = () => ({ title: values.title, body: bodyFrom(values['body-file']) });
  if (operation === 'issue') return { dryRun, ...text() };
  if (operation === 'push') return { dryRun, worktree: values.worktree ?? process.cwd(), branch: values.branch, commit: values.commit, expect: values.expect };
  if (operation === 'pull-request') return { dryRun, ...text(), branch: values.branch, commit: values.commit };
  return { dryRun };
}

main(import.meta, async () => {
  const { operation, upstream, values } = parsedArguments(process.argv.slice(2));
  const grant = grantFor(contributionPolicy(sandbox), upstream);
  const token = process.env[grant.credential];
  if (!token) throw new Error(`contribute: ${grant.credential} is not in the environment. Run this through session/contribute, which uses with-vault.`);
  const inputs = inputsFor(operation, values);
  // From here on, child processes see only basic settings: the one credential reaches git by name, never the rest of the vault environment.
  process.env = basicEnvironment(process.env, RUNTIME_SETTINGS);
  const operations = contributionOperations({ api: githubApi(token), git: gitFor(token), forkUrl: fork => `https://github.com/${fork}.git` });
  process.stdout.write(`${JSON.stringify(await operations[operation](grant, inputs), null, 2)}\n`);
});
