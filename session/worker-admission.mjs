import { readFileSync } from 'node:fs';
import { launchGraceMs } from './limits.mjs';
import { memoryShortage } from './memory-signals.mjs';

// Check twice per PSI avg10 window while leaving time for a newly opened process to allocate.
const CHECK_INTERVAL_MS = 5_000;

function sampleBlock(readText) {
  try {
    const reason = memoryShortage(readText);
    return reason === undefined ? undefined : new Error(reason);
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
    if (pendingStatusAge < launchGraceMs) {
      note(new Error('waiting for the first agent status'));
      return Math.min(CHECK_INTERVAL_MS, launchGraceMs - pendingStatusAge);
    }
    const block = sampleBlock(readText);
    note(block);
    return block ? retry() : undefined;
  }

  return { check, attempted: retry };
}
