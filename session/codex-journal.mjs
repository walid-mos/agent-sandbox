import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODEX_CONTRACT, refuseCodex } from './router-codex-contract.mjs';

function syncDirectory(path) {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function requirePrivateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw refuseCodex('journal parent must be private and owned');
}

export function durablePrivateFile(path, contents) {
  requirePrivateDirectory(dirname(path));
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  syncDirectory(dirname(path));
}

export class CodexJournal {
  constructor(path) {
    requirePrivateDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(dirname(path));
    this.path = path;
    this.runId = randomUUID();
    durablePrivateFile(join(path, 'owner.json'), JSON.stringify({ contract: CODEX_CONTRACT, runId: this.runId }));
    this.events = join(path, 'events.jsonl');
    durablePrivateFile(this.events, '');
  }

  record(step, state, evidence = {}) {
    const descriptor = openSync(this.events, 'a');
    try {
      writeSync(descriptor, `${JSON.stringify({ runId: this.runId, at: new Date().toISOString(), step, state, ...evidence })}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
  }

  async step(name, operation, measure) {
    this.record(name, 'INTENT');
    try {
      await operation();
      const evidence = await measure();
      this.record(name, 'CONFIRMED', evidence);
    } catch {
      this.record(name, 'UNKNOWN');
      throw refuseCodex(`${name} failed or could not be measured. No automatic retry`);
    }
  }
}
