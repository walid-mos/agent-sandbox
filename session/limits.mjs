import { sandbox } from './sandbox.mjs';

const DEFAULT_IDLE_STACK_MINUTES = 30;
const DEFAULT_IDLE_WORKER_MINUTES = 30;
const MINUTE_MS = 60_000;

function configured(name, minimum) {
  const value = sandbox[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`sandbox: ${name} must be a whole number of at least ${minimum}, got ${JSON.stringify(value)}. Correct it in the sandbox's file.`);
  }
  return value;
}

export const idleStackMinutes = configured('idleStackMinutes', 1) ?? DEFAULT_IDLE_STACK_MINUTES;

export function idleWorkerPolicy() {
  const { idleWorkerMinutes: minutes = DEFAULT_IDLE_WORKER_MINUTES } = sandbox;
  const maxMinutes = Math.floor(Number.MAX_SAFE_INTEGER / MINUTE_MS);
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > maxMinutes) {
    throw new Error('sandbox: idleWorkerMinutes must be a nonnegative whole number of minutes. Set 0 to disable it.');
  }
  return { pot: sandbox.bot, idleWorkerMinutes: minutes, enabled: minutes > 0 };
}

export const idleWorkerMs = policy => policy.idleWorkerMinutes * MINUTE_MS;
