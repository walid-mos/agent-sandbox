import { ANSWERED, RECEIVED, REFUSED } from './door-requests.mjs';
import { BOARD, BOARD_ACK, BOARD_VERSION, boardPacket, checkBoardReply, digest, DOOR_INTERVAL_MS, EVENTS, EVENTS_PER_PACKET, PUBLISH_MS, sectionPackets } from './pr-board-contract.mjs';
import { acceptBoard } from './pr-board-store.mjs';
import { reconcileDiscord } from './pr-board-delivery.mjs';

async function receive(options) {
  const { store, doors, configuration, now } = options;
  const requests = doors.all().filter(request => request.kind === BOARD && request.direction === RECEIVED && request.state !== ANSWERED);
  for (const request of requests) {
    const state = store.read();
    if (now - (state.receivedAttemptedAt ?? -Infinity) < DOOR_INTERVAL_MS) return;
    const accepted = acceptBoard(state, request.pot, boardPacket(request.need), configuration, now);
    store.save({ ...accepted, receivedAttemptedAt: now });
    await doors.reply(request.id, BOARD_ACK);
  }
}

function collect(options) {
  const { store, source, configuration, now, pot, isMastermind } = options;
  let state = store.read();
  if (state.publisher.outbox?.length || now - (state.publisher.collectedAt ?? -Infinity) < PUBLISH_MS) return;
  if (isMastermind && !Object.hasOwn(configuration.sources, pot)) return;
  const pulls = source.collect(now);
  const events = source.events().filter(event => !state.publisher.sentEvents?.includes(event.id));
  const packets = [];
  for (let index = 0; index < events.length; index += EVENTS_PER_PACKET) packets.push({ type: EVENTS, version: BOARD_VERSION, events: events.slice(index, index + EVENTS_PER_PACKET) });
  packets.push(...sectionPackets(pulls, now));
  if (isMastermind) {
    for (const packet of packets) state = acceptBoard(state, pot, packet, configuration, now);
    state.publisher = { ...state.publisher, collectedAt: now, sentEvents: [...(state.publisher.sentEvents ?? []), ...events.map(event => event.id)] };
  } else {
    state.publisher = { ...state.publisher, collectedAt: now, outbox: packets.map(packet => ({ packet })) };
  }
  store.save(state);
}

async function transmit(options) {
  const { store, doors, now } = options;
  const state = store.read();
  const next = state.publisher.outbox?.[0];
  if (!next || now - (state.publisher.attemptedAt ?? -Infinity) < DOOR_INTERVAL_MS) return;
  let request = next.request && doors.find(next.request);
  if (!request) request = doors.prepare({ pot: 'mastermind', need: JSON.stringify(next.packet), key: `board:${digest(next.packet)}` });
  next.request = request.id;
  state.publisher.attemptedAt = now;
  store.save(state);
  const sent = await doors.transmitAsync(request);
  if (sent.state === REFUSED) throw new Error('pr-board: receiver refused a saved board delivery. Correct configuration and explicitly retry the publisher.');
  if (sent.state !== ANSWERED) return;
  checkBoardReply(sent.reply);
  state.publisher.outbox.shift();
  const events = next.packet.type === EVENTS ? next.packet.events.map(event => event.id) : [];
  state.publisher.sentEvents = [...new Set([...(state.publisher.sentEvents ?? []), ...events])];
  store.save(state);
}

export async function runBoardPass(options) {
  if (options.configuration?.enabled !== true) return;
  const { isMastermind, onError = () => {} } = options;
  if (isMastermind) {
    try { await receive(options); } catch { onError('A received board packet remains pending.'); }
    try { await reconcileDiscord({ ...options, client: options.discord }); } catch { onError('A Discord board update remains pending.'); }
  }
  try { collect(options); } catch { onError('Local collection failed. No partial section was published.'); }
  if (!isMastermind) {
    try { await transmit(options); } catch { onError('An outgoing board packet remains pending.'); }
  }
}
