import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CODE_HOME, DELEGATIONS_HOME, EXECUTION_HOME, GATE_HOME, RUNTIME_HOME, RUNS_HOME, checkedExecution } from './launch-execution-contract.mjs';

const REPORT_BYTES = 1024 * 1024;

export function requireGate() {
  if (process.getuid() !== 0 || process.geteuid() !== 0) throw new Error('mac-launch: only the protected root gate may perform this operation.');
  if (process.platform !== 'darwin') throw new Error('mac-launch: native Mac identity and sandbox enforcement are unavailable on this platform.');
}

function collectProtected(path, inspected) {
  let current = resolve(path);
  for (;;) {
    if (inspected.has(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('mac-launch: gate code, runtime and their ancestors must be root-owned, not writable by execution, with no symlinks.');
    inspected.add(current);
    if (current === dirname(current)) return;
    current = dirname(current);
  }
}

function checkNativeAcls(inspected) {
  if (process.platform !== 'darwin') return;
  const paths = [...inspected];
  const batchSize = 100;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    const listing = execFileSync('/bin/ls', ['-lde', ...paths.slice(offset, offset + batchSize)], { encoding: 'utf8', maxBuffer: REPORT_BYTES });
    if (/^\s*\d+:/m.test(listing)) throw new Error('mac-launch: protected paths must have no extended ACL grants. Native isolation is blocked.');
  }
}

export function protectedPath(path) {
  const inspected = new Set();
  collectProtected(path, inspected);
  checkNativeAcls(inspected);
}

function protectedTree(path) {
  const inspected = new Set();
  function visit(folder) {
    collectProtected(folder, inspected);
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const child = join(folder, entry.name);
      collectProtected(child, inspected);
      if (entry.isDirectory()) visit(child);
      else if (!entry.isFile()) throw new Error('mac-launch: protected code/runtime contains a special file.');
    }
  }
  visit(path);
  checkNativeAcls(inspected);
}

const INVALID_REPORT = 'mac-launch: report must be a bounded regular file of the execution account.';

function requireReportFile(stat, owner, limit) {
  if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1 || stat.size > limit) throw new Error(INVALID_REPORT);
}

function readReport(descriptor, limit) {
  const content = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < content.length) {
    const count = readSync(descriptor, content, length, content.length - length);
    if (!count) break;
    length += count;
  }
  if (length > limit) throw new Error('mac-launch: report exceeded its byte limit.');
  return content.subarray(0, length).toString('utf8');
}

export function readBounded(path, owner, limit = REPORT_BYTES) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireReportFile(fstatSync(descriptor), owner, limit);
    return readReport(descriptor, limit);
  } finally { closeSync(descriptor); }
}

export function readSecret(path) {
  protectedPath(path);
  if (lstatSync(path).mode & 0o077) throw new Error('mac-launch: delegated and gate credentials must be private, mode 0600.');
  return readBounded(path, 0);
}

function requireProtectedDirectories() {
  const folders = [GATE_HOME, DELEGATIONS_HOME, CODE_HOME, RUNTIME_HOME, EXECUTION_HOME, RUNS_HOME];
  for (const folder of folders) protectedPath(folder);
}

function requirePrivateGateHomes() {
  for (const folder of [GATE_HOME, DELEGATIONS_HOME]) {
    if ((lstatSync(folder).mode & 0o777) !== 0o700) throw new Error('mac-launch: gate and delegation homes must be mode 0700.');
  }
}

function requireProtectedCode() {
  for (const path of [CODE_HOME, RUNTIME_HOME]) protectedTree(path);
}

function requireProtectedTools(settings) {
  for (const path of Object.values(settings.tools)) protectedPath(path);
}

function requireSelectedWork(settings, execution) {
  protectedPath(dirname(settings.directory));
  const work = lstatSync(settings.directory);
  if (!work.isDirectory() || work.isSymbolicLink() || work.uid !== execution.uid || (work.mode & 0o777) !== 0o700) {
    throw new Error('mac-launch: selected work must be a real execution-owned directory, mode 0700.');
  }
}

export function checkProtectedInstallation(settings) {
  requireGate();
  const execution = checkedExecution(settings);
  requireProtectedDirectories();
  requirePrivateGateHomes();
  requireProtectedCode();
  requireProtectedTools(settings);
  requireSelectedWork(settings, execution);
}
