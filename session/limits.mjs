import { totalmem } from 'node:os';
import { sandbox } from './sandbox.mjs';

const GIB = 1024 ** 3;
// Assumed until a pot is measured with bin/pots-load: the session's own services, then one worker with its tools and a development stack at rest.
const SESSION_GIB = 2;
const WORKER_GIB = 3;

export const defaultMaxWorkers = memoryBytes => Math.max(1, Math.floor((memoryBytes / GIB - SESSION_GIB) / WORKER_GIB));

function configured(name, minimum) {
  const value = sandbox[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`sandbox: ${name} must be a whole number of at least ${minimum}, got ${JSON.stringify(value)}. Correct it in the sandbox's file.`);
  }
  return value;
}

export const maxWorkers = configured('maxWorkers', 1) ?? defaultMaxWorkers(totalmem());
