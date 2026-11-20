import { noticeboardConfiguration, NOTICEBOARD_LIMITS } from './noticeboard-policy.mjs';
import { noticeboardPass } from './noticeboard-worker.mjs';

const completedObservation = new Set(['ignored', 'observed']);

async function intake(context, configuration) {
  const { client, store } = context;
  try {
    const events = await client.readEvents(store.cursor(), { channelIds: configuration.channels.map(route => route.channelId), limit: NOTICEBOARD_LIMITS.batch });
    store.enqueue(events);
    return 'read';
  } catch { return 'held'; }
}

export async function noticeboardServicePass(context) {
  const configuration = noticeboardConfiguration(context.configuration);
  if (!configuration.enabled) return { status: 'disabled' };
  const intakeStatus = await intake(context, configuration);
  const { store, now } = context;
  for (const event of store.pendingEvents(now)) {
    const result = await noticeboardPass({ ...context, event });
    if (completedObservation.has(result?.observation)) store.complete(event.id);
    else if (result?.status !== 'busy') store.defer(event.id, now, result?.retry);
  }
  await noticeboardPass({ ...context, event: undefined });
  store.exhaust(now);
  store.prune(now);
  return { status: 'preservation-only', intake: intakeStatus, deletion: 'conditional-delete-unavailable' };
}
