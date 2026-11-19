import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORIES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'factory-repositories.json');
const STEP_NAME = /^[a-z0-9-]+$/;

const isCommand = run => Array.isArray(run) && run.length > 0 && run.every(part => typeof part === 'string');
const isStep = step => Boolean(step) && STEP_NAME.test(step.name) && isCommand(step.run)
  && ['undefined', 'boolean'].includes(typeof step.network);

function repositories() {
  const definitions = JSON.parse(readFileSync(REPOSITORIES_FILE, 'utf8'));
  const listed = Object.fromEntries(Object.entries(definitions).map(([repository, steps]) =>
    [repository.toLowerCase(), typeof steps === 'string' ? definitions[steps] : steps]));
  const invalid = Object.entries(listed).filter(([, steps]) => !Array.isArray(steps) || steps.length === 0 || !steps.every(isStep));
  if (invalid.length > 0) {
    throw new Error(`factory: ${REPOSITORIES_FILE} has bad steps for ${invalid.map(([name]) => name).join(', ')}. Give each step a lowercase name, a run array of strings and an optional network boolean, or reference a repository with those steps.`);
  }
  return listed;
}

export const hasChecks = repository => Object.hasOwn(repositories(), repository.toLowerCase());

export function checkSteps(repository) {
  const steps = repositories()[repository.toLowerCase()];
  if (!steps) throw new Error(`factory: ${REPOSITORIES_FILE} defines no checks for ${repository}. Define them before the factory checks its pull requests.`);
  return steps;
}
