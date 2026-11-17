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

export async function commandOutput(binary, arguments_, options = {}) {
  return (await runFile(binary, arguments_, { ...OUTPUT_LIMIT, ...options })).stdout.trim();
}

/** Runs a command with `input` on its stdin, and resolves once it exits cleanly. */
export function commandWithInput(binary, arguments_, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, arguments_, options, error => (error ? reject(error) : resolve()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const failureReason = error => `${error?.stderr ?? ''}`.trim().split('\n')[0];
