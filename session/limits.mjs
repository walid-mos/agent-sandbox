import { sandbox } from './sandbox.mjs';

const DEFAULT_IDLE_STACK_MINUTES = 30;

function configured(name, minimum) {
  const value = sandbox[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`sandbox: ${name} must be a whole number of at least ${minimum}, got ${JSON.stringify(value)}. Correct it in the sandbox's file.`);
  }
  return value;
}

export const maxWorkers = configured('maxWorkers', 1);
export const idleStackMinutes = configured('idleStackMinutes', 1) ?? DEFAULT_IDLE_STACK_MINUTES;
