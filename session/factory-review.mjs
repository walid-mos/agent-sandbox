import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FACTORY_HOME } from './factory-records.mjs';
import { readJson, writePrivateJson } from './private-json.mjs';

const REVIEWS = join(FACTORY_HOME, 'reviews');
const reviewId = ({ repository, number, head, generation }) => createHash('sha256')
  .update(JSON.stringify([repository, number, head, generation])).digest('hex');
const bindingPath = id => join(REVIEWS, `${id}.json`);

export function bindReview(pull) {
  const { repository, number, head, generation } = pull;
  const binding = { repository, number, head, generation };
  const id = reviewId(binding);
  writePrivateJson(bindingPath(id), binding);
  return id;
}

export function requireBinding(id = '') {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('factory: use the review command from the current wake');
  const binding = readJson(bindingPath(id));
  if (!binding || reviewId(binding) !== id) throw new Error('factory: no matching review binding from the current wake');
  return binding;
}
