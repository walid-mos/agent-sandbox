import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignments } from './environment.mjs';

const launch = () => assignments(readFileSync(new URL('./launch.env', import.meta.url), 'utf8'));
const LOCK_DESCRIPTOR = 3;
export class AdmissionDeferred extends Error {
  constructor() { super('Worker admission is paused for a release switch.'); }
}

function checkRelease(control, release) {
  const revision = readFileSync(release, 'utf8').trim();
  const { phase, known_good: knownGood, loaded } = JSON.parse(readFileSync(join(control, 'status.json'), 'utf8'));
  if (phase !== 'ready' || revision !== knownGood || revision !== loaded) throw new AdmissionDeferred();
}

export function withAdmission(operation) {
  const { POTS_ADMISSION: control, POTS_RELEASE_ID: release } = launch();
  if (!existsSync(control) && !existsSync(release)) return operation();
  let descriptor;
  try {
    descriptor = openSync(join(control, 'admission.lock'), 'r');
    const lock = spawnSync('flock', ['--shared', '--nonblock', `${LOCK_DESCRIPTOR}`], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor],
    });
    if (lock.status !== 0) throw new AdmissionDeferred();
    checkRelease(control, release);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new AdmissionDeferred();
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
  }
}
