import { readFileSync } from 'node:fs';
import { optionalMetric, readGroupMemory } from './cgroup-memory.mjs';

// Check twice per PSI avg10 window while leaving time for a newly opened process to allocate.
const CHECK_INTERVAL_MS = 5_000;
const AGENT_STARTUP_GRACE_MS = 30_000;
// The absolute floor protects the session on small guests; the share lets the reserve grow with guest memory.
const MIN_AVAILABLE_KIB = 256 * 1024;
const MIN_AVAILABLE_SHARE = 0.05;
// Full stalls stop all non-idle work, so they block admission at a lower share than partial stalls.
const SOME_STALL_PERCENT = 5;
const FULL_STALL_PERCENT = 1;
const MEMINFO = '/proc/meminfo';
const MEMORY_PSI = '/proc/pressure/memory';

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

function guestMemoryBlock(readText) {
  const meminfo = readText(MEMINFO);
  const total = memoryAmount(meminfo, 'MemTotal');
  const available = memoryAmount(meminfo, 'MemAvailable');
  if (total === 0 || available > total) throw new Error(`${MEMINFO}: inconsistent MemTotal and MemAvailable`);
  if (available < Math.max(MIN_AVAILABLE_KIB, total * MIN_AVAILABLE_SHARE)) return 'low available memory';
  return isStalled(optionalMetric(readText, MEMORY_PSI), MEMORY_PSI) ? 'memory pressure stalls' : undefined;
}

function groupMemoryBlock(readText) {
  for (const { limit, available, pressurePath, pressure } of readGroupMemory(readText)) {
    if (limit === 0 || available < limit * MIN_AVAILABLE_SHARE) return `${pressurePath}: low cgroup memory headroom`;
    if (isStalled(pressure, pressurePath)) return `${pressurePath}: cgroup memory pressure stalls`;
  }
  return undefined;
}

function sampleBlock(readText) {
  try {
    const reason = guestMemoryBlock(readText) ?? groupMemoryBlock(readText);
    return reason && new Error(reason);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function createAdmission({ logFailure, readText = path => readFileSync(path, 'utf8'), now = () => performance.now() }) {
  let nextCheckAt = -Infinity;
  let lastReason;

  function retry() {
    nextCheckAt = now() + CHECK_INTERVAL_MS;
    return CHECK_INTERVAL_MS;
  }

  function note(block) {
    if (block && block.message !== lastReason) logFailure('memory admission', block);
    lastReason = block?.message;
  }

  function check({ latestLaunchAge = Infinity, pendingStatusAge = Infinity }) {
    const remaining = Math.max(nextCheckAt - now(), CHECK_INTERVAL_MS - latestLaunchAge);
    if (remaining > 0) return remaining;
    if (pendingStatusAge < AGENT_STARTUP_GRACE_MS) {
      note(new Error('waiting for the first agent status'));
      return Math.min(CHECK_INTERVAL_MS, AGENT_STARTUP_GRACE_MS - pendingStatusAge);
    }
    const block = sampleBlock(readText);
    note(block);
    return block ? retry() : undefined;
  }

  return { check, attempted: retry };
}
