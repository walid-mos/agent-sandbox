import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FACTORY_HOME, pullArguments, requireRecord } from './factory-records.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

const REVIEWS = join(FACTORY_HOME, 'reviews');
const reviewId = ({ repository, number, head, generation }) => createHash('sha256')
  .update(JSON.stringify([repository, number, head, generation])).digest('hex');
const bindingPath = id => join(REVIEWS, `${id}.json`);

export function bindReview({ repository, number, head, generation }) {
  const pull = pullArguments([repository, String(number), head]);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('factory: a checked review needs its scan generation.');
  const binding = { ...pull, generation };
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

export function requireReview(id) {
  const record = requireRecord(readBinding(id), 'checked');
  if (reviewId(record) !== id) throw new Error('factory: the checked record no longer matches this review attempt.');
  return record;
}
