import { posix } from 'node:path';

const MEMBERSHIP = '/proc/self/cgroup';
const MOUNTS = '/proc/self/mountinfo';
const UNSUPPORTED = new Set(['EOPNOTSUPP', 'ENOTSUP']);

export function optionalMetric(readText, path) {
  try {
    return readText(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || UNSUPPORTED.has(error?.code)) return undefined;
    throw error;
  }
}

function groupOf(text) {
  const rows = text.trim().split('\n').filter(Boolean);
  const groups = rows.map(row => {
    const match = /^(\d+):([^:]*):(\/.*)$/.exec(row);
    if (!match) throw new Error(`${MEMBERSHIP}: invalid entry`);
    return { id: match[1], controllers: match[2], path: match[3] };
  });
  const group = groups.find(({ id, controllers }) => id === '0' && controllers === '');
  if (groups.some(({ controllers }) => controllers.split(',').includes('memory'))) {
    throw new Error(`${MEMBERSHIP}: cgroup v1 memory accounting is unsupported`);
  }
  if (!group) return undefined;
  if (posix.normalize(group.path) !== group.path || group.path.split('/').includes('..')) {
    throw new Error(`${MEMBERSHIP}: worker group is outside the visible namespace`);
  }
  return group.path;
}

function decodeMountPath(field) {
  return field?.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function mountFor(text) {
  const mounts = text.split('\n').map(line => {
    const [fields, filesystem] = line.split(' - ');
    if (filesystem?.split(' ')[0] !== 'cgroup2') return undefined;
    const [, , , root, target] = fields.split(' ');
    return { root: decodeMountPath(root), target: decodeMountPath(target) };
  });
  const mount = mounts.find(entry => entry?.root === '/' && entry.target?.startsWith('/') && posix.normalize(entry.target) === entry.target);
  if (!mount) throw new Error(`${MOUNTS}: no cgroup v2 mount exposes all namespace ancestors`);
  return mount.target;
}

function groupTrace(group, mount) {
  const scopes = [posix.join(mount, group)];
  while (scopes.at(-1) !== mount) scopes.push(posix.dirname(scopes.at(-1)));
  return scopes;
}

function bytes(text, path) {
  const value = Number(text);
  if (!/^\d+$/.test(text?.trim()) || !Number.isSafeInteger(value)) throw new Error(`${path}: invalid byte count`);
  return value;
}

function noMemoryController(readText, scope, parent) {
  if (parent) return !readText(`${parent}/cgroup.subtree_control`).trim().split(/\s+/).includes('memory');
  if (optionalMetric(readText, `${scope}/cgroup.type`) === undefined) return true;
  return !readText(`${scope}/cgroup.controllers`).trim().split(/\s+/).includes('memory');
}

function limitsAt(readText, scope, parent) {
  const paths = ['memory.high', 'memory.max'].map(field => `${scope}/${field}`);
  const readings = paths.map(path => optionalMetric(readText, path));
  if (readings.every(value => value === undefined) && noMemoryController(readText, scope, parent)) return Infinity;
  return Math.min(...readings.map((value, index) => value?.trim() === 'max' ? Infinity : bytes(value, paths[index])));
}

function inactiveFileAt(readText, scope) {
  const path = `${scope}/memory.stat`;
  const text = optionalMetric(readText, path);
  if (text === undefined) return 0;
  const line = text.split('\n').find(row => /^inactive_file\b/.test(row));
  return line === undefined ? 0 : bytes(/^inactive_file[ \t]+(.+)$/.exec(line)?.[1], path);
}

export function readGroupMemory(readText) {
  const group = groupOf(readText(MEMBERSHIP));
  if (group === undefined) return [];
  const mount = mountFor(readText(MOUNTS));
  const scopes = groupTrace(group, mount);
  return scopes.map((scope, index) => {
    const limit = limitsAt(readText, scope, scopes[index + 1]);
    const current = Number.isFinite(limit) ? bytes(readText(`${scope}/memory.current`), `${scope}/memory.current`) : 0;
    const reclaimable = Number.isFinite(limit) ? Math.min(current, inactiveFileAt(readText, scope)) : 0;
    return { limit, available: limit - (current - reclaimable), pressurePath: `${scope}/memory.pressure` };
  });
}
