import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FACTORY_HOME, requireRecord } from './factory-records.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

const REVIEWS = join(FACTORY_HOME, 'reviews');
const BOUND = ['repository', 'number', 'head', 'base', 'baseTip', 'transition', 'inputRevision', 'generation'];

export const reviewId = pull => createHash('sha256')
  .update(JSON.stringify(BOUND.map(key => pull[key]))).digest('hex');
const bindingPath = id => join(REVIEWS, `${id}.json`);

export function bindReview(pull) {
  if (isDurableFactory && !Number.isSafeInteger(pull.generation)) throw new Error('factory: a checked review needs its scan generation.');
  const binding = Object.fromEntries(BOUND.filter(key => pull[key] !== undefined).map(key => [key, pull[key]]));
  const id = reviewId(binding);
  writePrivateJson(bindingPath(id), binding);
  return id;
}

function readBinding(id) {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('factory: use the review command from the checked wake.');
  const binding = readJson(bindingPath(id));
  if (!binding || reviewId(binding) !== id) throw new Error('factory: no matching review binding from the checked wake.');
  return binding;
}

export const requireBinding = readBinding;

export function requireReview(id) {
  const record = requireRecord(readBinding(id), 'checked');
  if (reviewId(record) !== id) throw new Error('factory: the checked record no longer matches this review attempt.');
  return record;
}
