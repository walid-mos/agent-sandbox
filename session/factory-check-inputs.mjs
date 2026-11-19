import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { command } from './run.mjs';

const SHARED_EXECUTION_FILES = ['factory-checks.mjs', 'factory-container.mjs', 'factory-mirror.mjs', 'factory-check-inputs.mjs'];
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

export function snapshotCheckInputs({ pull, base, steps, image, imageDirectory, snapshot }) {
  const imageId = command('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  if (!IMAGE_ID.test(imageId)) throw new Error('factory: Docker did not confirm an immutable check image ID');
  cpSync(imageDirectory, snapshot, { recursive: true });
  const helpers = readdirSync(snapshot).sort().map(name => [name, readFileSync(join(snapshot, name)).toString('base64')]);
  const execution = SHARED_EXECUTION_FILES.map(name => readFileSync(new URL(name, import.meta.url)).toString('base64'));
  const { repository, number, head, transition } = pull;
  const digest = createHash('sha256').update(JSON.stringify([
    repository, number, head, pull.base, transition, base, imageId, process.platform, process.arch, steps, helpers, execution,
  ])).digest('hex');
  return { image: imageId, imageDirectory: snapshot, inputDigest: digest };
}
