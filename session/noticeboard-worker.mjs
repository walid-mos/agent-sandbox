import { matchesArchive, prepareArchive } from './noticeboard-archive.mjs';
import { isHumanComment, noticeboardConfiguration, NOTICEBOARD_LIMITS, routeFor, snapshotKey, snapshotOf } from './noticeboard-policy.mjs';
import { SNOWFLAKE } from './human-contract.mjs';
import { deferredAttempt } from './noticeboard-retry.mjs';

const canPreserve = permissions => ['canRead', 'canWrite', 'canManageMessages', 'isThreadBound'].every(key => permissions[key] === true);
const isCopy = (copy, route) => typeof copy?.id === 'string' && SNOWFLAKE.test(copy.id) && copy.channelId === route.threadId;
const pending = record => ['observed', 'captured', 'acknowledged', 'copy-unknown', 'copied'].includes(record.stage);

async function observe(context, configuration) {
  const { event, client, store, now } = context;
  const route = routeFor(event, configuration);
  if (!route || event.kind === 'delete') return 'ignored';
  if (!canPreserve(await client.permissions(route))) return 'read-only';
  const original = await client.read(route, event.messageId);
  if (!original) return 'source-unavailable';
  const snapshot = snapshotOf(original, event, route);
  if (!isHumanComment(snapshot)) return 'ignored';
  const key = snapshotKey(snapshot);
  if (store.get(key)) return 'observed';
  store.put({ key, snapshot, route, stage: 'observed', nonce: key.slice(0, 24), createdAt: now, attempts: 0, retryAt: now });
  return 'observed';
}

async function sendCopy(record, context) {
  const { store, client } = context;
  if (record.stage === 'observed') {
    const prepared = prepareArchive(record.snapshot);
    record = prepared.archive ? { ...record, archive: prepared.archive, stage: 'captured' } : { ...record, stage: 'held', reason: prepared.reason };
    store.put(record);
  }
  if (record.stage === 'captured') {
    await client.react(record.route, record.snapshot.id);
    record = { ...record, stage: 'acknowledged' };
    store.put(record);
  }
  if (record.stage !== 'acknowledged') return record;
  record = { ...record, stage: 'copy-unknown' };
  store.put(record);
  const copy = await client.createCopy({ ...record.archive, nonce: record.nonce, enforce_nonce: true, channelId: record.route.threadId }, record.route);
  if (!isCopy(copy, record.route)) return record;
  record = { ...record, stage: 'copied', copy: { id: copy.id, channelId: copy.channelId } };
  store.put(record);
  return record;
}

async function reconcile(record, context) {
  const result = await context.client.findCopy(record.route, { nonce: record.nonce, fingerprint: record.key, limit: NOTICEBOARD_LIMITS.batch });
  if (result?.status !== 'found' || !isCopy(result.copy, record.route)) return record;
  const { id, channelId } = result.copy;
  const next = { ...record, stage: 'copied', copy: { id, channelId } };
  context.store.put(next);
  return next;
}

async function advance(record, context) {
  const { client, store, now } = context;
  const attempted = { ...record, attempts: record.attempts + 1,
    retryAt: now + NOTICEBOARD_LIMITS.retryMs * 2 ** record.attempts };
  store.put(attempted);
  try {
    if (!canPreserve(await client.permissions(record.route))) {
      store.put({ ...attempted, reason: 'permissions-unavailable' });
      return;
    }
    const resolved = attempted.stage === 'copy-unknown' ? await reconcile(attempted, context) : await sendCopy(attempted, context);
    if (resolved.stage !== 'copied') return;
    const actual = await client.readCopy(resolved.copy, resolved.route);
    const isVerified = matchesArchive(resolved.archive, actual, resolved.copy);
    store.put({ ...resolved, stage: isVerified ? 'verified' : 'held', verifiedAt: isVerified ? now : undefined,
      reason: isVerified ? 'conditional-delete-unavailable' : 'copy-verification-failed' });
  } catch (error) {
    const current = store.get(record.key);
    store.put(deferredAttempt(current, error, now));
  }
}

async function pass(context, configuration) {
  const { store, now } = context;
  let observation;
  let retry = {};
  try { observation = await observe(context, configuration); } catch (error) {
    observation = 'capture-unavailable';
    retry = deferredAttempt({ attempts: 0, retryAt: now }, error, now);
  }
  const records = store.records().filter(record => pending(record) && record.attempts < NOTICEBOARD_LIMITS.attempts && now >= record.retryAt).slice(0, NOTICEBOARD_LIMITS.batch);
  for (const record of records) {
    if (!configuration.channels.some(route => JSON.stringify(route) === JSON.stringify(record.route))) continue;
    await advance(record, context);
  }
  return { status: 'preservation-only', observation, retry, deletion: 'conditional-delete-unavailable' };
}

export async function noticeboardPass(context) {
  const configuration = noticeboardConfiguration(context.configuration);
  if (!configuration.enabled) return { status: 'disabled' };
  if (!Number.isSafeInteger(context.now)) throw new Error('noticeboards: supply a bounded clock timestamp.');
  return context.store.exclusive(() => pass(context, configuration));
}
