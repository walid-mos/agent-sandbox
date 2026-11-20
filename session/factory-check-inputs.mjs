import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { command } from './run.mjs';

const SHARED_EXECUTION_FILES = ['factory-checks.mjs', 'factory-container.mjs', 'factory-mirror.mjs', 'factory-check-inputs.mjs'];
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

export function checkInputRevision({ steps, image, imageDirectory, snapshot }) {
  const imageId = command('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 5_000, killSignal: 'SIGKILL' });
  if (!IMAGE_ID.test(imageId)) throw new Error('factory: Docker did not confirm an immutable check image ID');
  if (snapshot) cpSync(imageDirectory, snapshot, { recursive: true, preserveTimestamps: true });
  const helpersPath = snapshot ?? imageDirectory;
  const helpers = readdirSync(helpersPath).sort().map(name => {
    const path = join(helpersPath, name);
    return [name, statSync(path).mode, readFileSync(path).toString('base64')];
  });
  const execution = SHARED_EXECUTION_FILES.map(name => readFileSync(new URL(name, import.meta.url)).toString('base64'));
  return { image: imageId, imageDirectory: helpersPath, inputRevision: digest([imageId, steps, helpers, execution]) };
}

function digest(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function reusableCheckDigest({ repository, number, head, transition, base }, mergeBase, inputRevision) {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return digest([repository, number, head, transition, base, mergeBase, inputRevision, boot, process.platform, process.arch]);
}
