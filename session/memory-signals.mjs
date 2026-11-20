import { readFileSync } from 'node:fs';
import { optionalMetric, readGroupMemory } from './cgroup-memory.mjs';

// The absolute floor protects the session on small guests; the share lets the reserve grow with guest memory.
const MIN_AVAILABLE_KIB = 256 * 1024;
const MIN_AVAILABLE_SHARE = 0.05;
// Full stalls stop all non-idle work, so they count at a lower share than partial stalls.
const SOME_STALL_PERCENT = 5;
const FULL_STALL_PERCENT = 1;
const MEMINFO = '/proc/meminfo';
const MEMORY_PSI = '/proc/pressure/memory';

const readTextFile = path => readFileSync(path, 'utf8');

function memoryAmount(text, field) {
  const line = text.split('\n').find(candidate => candidate.startsWith(`${field}:`));
  const amount = Number(/^[^:]+:[ \t]+(\d+)[ \t]+kB[ \t]*$/.exec(line)?.[1]);
  if (!Number.isSafeInteger(amount)) throw new Error(`${MEMINFO}: invalid ${field}`);
  return amount;
}

function stallPercent(text, path, kind) {
  const line = text.split('\n').find(candidate => candidate.startsWith(`${kind} `));
  const percent = Number(/(?:^| )avg10=(\d+(?:\.\d+)?)(?: |$)/.exec(line)?.[1]);
  if (!(percent >= 0 && percent <= 100)) throw new Error(`${path}: invalid ${kind} avg10`);
  return percent;
}

function isStalled(pressure, path) {
  if (pressure === undefined) return false;
  const some = stallPercent(pressure, path, 'some');
  const full = stallPercent(pressure, path, 'full');
  return some >= SOME_STALL_PERCENT || full >= FULL_STALL_PERCENT;
}

function guestShortage(readText) {
  const meminfo = readText(MEMINFO);
  const total = memoryAmount(meminfo, 'MemTotal');
  const available = memoryAmount(meminfo, 'MemAvailable');
  if (total === 0 || available > total) throw new Error(`${MEMINFO}: inconsistent MemTotal and MemAvailable`);
  if (available < Math.max(MIN_AVAILABLE_KIB, total * MIN_AVAILABLE_SHARE)) return 'low available memory';
  return isStalled(optionalMetric(readText, MEMORY_PSI), MEMORY_PSI) ? 'memory pressure stalls' : undefined;
}

function groupShortage(readText) {
  for (const { limit, available, pressurePath, pressure } of readGroupMemory(readText)) {
    if (limit === 0 || available < limit * MIN_AVAILABLE_SHARE) return `${pressurePath}: low cgroup memory headroom`;
    if (isStalled(pressure, pressurePath)) return `${pressurePath}: cgroup memory pressure stalls`;
  }
  return undefined;
}

/** Why the guest or the worker group is short on memory, or undefined when it still has room. Throws when a signal cannot be read. */
export function memoryShortage(readText = readTextFile) {
  return guestShortage(readText) ?? groupShortage(readText);
}
