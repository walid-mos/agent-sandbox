import { readFileSync } from 'node:fs';

// Check twice per PSI avg10 window while leaving time for a newly opened process to allocate.
const CHECK_INTERVAL_MS = 5_000;
// The absolute floor protects the session on small guests; the share lets the reserve grow with guest memory.
const MIN_AVAILABLE_KIB = 256 * 1024;
const MIN_AVAILABLE_SHARE = 0.05;
// Full stalls stop all non-idle work, so they block admission at a lower share than partial stalls.
const SOME_STALL_PERCENT = 5;
const FULL_STALL_PERCENT = 1;
const MEMINFO = '/proc/meminfo';
const MEMORY_PSI = '/proc/pressure/memory';
const PSI_UNAVAILABLE = new Set(['ENOENT', 'EOPNOTSUPP', 'ENOTSUP']);

function memoryAmount(text, field) {
  const line = text.split('\n').find(candidate => candidate.startsWith(`${field}:`));
  const amount = Number(/^[^:]+:[ \t]+(\d+)[ \t]+kB[ \t]*$/.exec(line)?.[1]);
  if (!Number.isSafeInteger(amount)) throw new Error(`${MEMINFO}: invalid ${field}`);
  return amount;
}

function stallPercent(text, kind) {
  const line = text.split('\n').find(candidate => candidate.startsWith(`${kind} `));
  const percent = Number(/(?:^| )avg10=(\d+(?:\.\d+)?)(?: |$)/.exec(line)?.[1]);
  if (!(percent >= 0 && percent <= 100)) throw new Error(`${MEMORY_PSI}: invalid ${kind} avg10`);
  return percent;
}

function readPressure(readText) {
  try {
    return readText(MEMORY_PSI);
  } catch (error) {
    if (PSI_UNAVAILABLE.has(error?.code)) return undefined;
    throw error;
  }
}

function memoryBlock(readText) {
  const meminfo = readText(MEMINFO);
  const total = memoryAmount(meminfo, 'MemTotal');
  const available = memoryAmount(meminfo, 'MemAvailable');
  if (total === 0 || available > total) throw new Error(`${MEMINFO}: inconsistent MemTotal and MemAvailable`);
  if (available < Math.max(MIN_AVAILABLE_KIB, total * MIN_AVAILABLE_SHARE)) return 'low available memory';
  const pressure = readPressure(readText);
  if (pressure === undefined) return undefined;
  const some = stallPercent(pressure, 'some');
  const full = stallPercent(pressure, 'full');
  if (some >= SOME_STALL_PERCENT || full >= FULL_STALL_PERCENT) return 'memory pressure stalls';
  return undefined;
}

function sampleBlock(readText) {
  try {
    const reason = memoryBlock(readText);
    return reason && new Error(reason);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function createAdmission({ ceiling, logFailure, readText = path => readFileSync(path, 'utf8'), now = () => performance.now() }) {
  let nextCheckAt = -Infinity;
  let lastReason;

  function retry() {
    nextCheckAt = now() + CHECK_INTERVAL_MS;
    return CHECK_INTERVAL_MS;
  }

  function check({ running, hasStartingWorker }) {
    const remaining = nextCheckAt - now();
    if (remaining > 0) return remaining;
    const atCeiling = ceiling !== undefined && running >= ceiling;
    if (atCeiling || hasStartingWorker) return CHECK_INTERVAL_MS;
    const block = sampleBlock(readText);
    if (block && block.message !== lastReason) logFailure('memory admission', block);
    lastReason = block?.message;
    return block ? retry() : undefined;
  }

  return { check, attempted: retry };
}
