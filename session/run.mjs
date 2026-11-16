import { execFile, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const WITH_VAULT = join(dirname(fileURLToPath(import.meta.url)), 'with-vault');
const OUTPUT_LIMIT = { encoding: 'utf8', maxBuffer: 1024 * 1024 };
const runFile = promisify(execFile);

export function command(binary, arguments_, options = {}) {
  return execFileSync(binary, arguments_, { ...OUTPUT_LIMIT, ...options }).trim();
}

export async function commandOutput(binary, arguments_) {
  return (await runFile(binary, arguments_, OUTPUT_LIMIT)).stdout.trim();
}

export const failureReason = error => `${error?.stderr ?? ''}`.trim().split('\n')[0];
