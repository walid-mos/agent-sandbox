import { registerQuestion } from '../../session/discord-registration.mjs';
import { humanNeed } from '../../session/human-door-packets.mjs';

export async function acknowledgedRegistration(registration, store, identity) {
  const original = { id: registration.request, direction: 'received', kind: 'dialog', pot: registration.pot, need: humanNeed(registration.question) };
  const doors = {
    find: id => id === original.id ? original : undefined,
    prepare: ({ need, pot }) => ({ id: 'mastermind.12345678', kind: 'dialog', direction: 'asked', need, pot, state: 'unknown' }),
    transmit: request => ({ ...request, state: 'answered', reply: '{"type":"human.posted-ack","version":1}' }),
  };
  const result = await registerQuestion(registration, { store, identity, doors });
  if (!result.registered) throw new Error(`Fixture registration failed: ${JSON.stringify(result)}`);
  return store.get(result.dialog);
}
