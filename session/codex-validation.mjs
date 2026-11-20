import { isDeepStrictEqual } from 'node:util';
import { refuseCodex } from './codex-contract-names.mjs';

export function requireEqual(expected, actual, reason) {
  if (!isDeepStrictEqual(expected, actual)) throw refuseCodex(reason);
}

export function requireObject(value, reason) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuseCodex(reason);
}

export function requireFields(expected, record, reason) {
  requireObject(record, reason);
  for (const [field, wanted] of Object.entries(expected)) requireEqual(wanted, record[field], reason);
}

export function requireString(value, reason) {
  if (typeof value !== 'string' || !value.length) throw refuseCodex(reason);
}

export function requireArray(value, reason) {
  if (!Array.isArray(value)) throw refuseCodex(reason);
}

export function dateMilliseconds(value, reason) {
  requireString(value, reason);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw refuseCodex(reason);
  return milliseconds;
}

export function requirePastDate(value, now, reason) {
  const milliseconds = dateMilliseconds(value, reason);
  if (milliseconds > now) throw refuseCodex(reason);
  return milliseconds;
}

export function requireMinimumInteger(value, minimum, reason) {
  if (!Number.isInteger(value) || value < minimum) throw refuseCodex(reason);
}
