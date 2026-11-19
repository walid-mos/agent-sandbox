import { createHash } from 'node:crypto';
import { BOARD, isPotName, Refusal } from './door-messages.mjs';
import { isCalendarDay } from './factory-stale-draft.mjs';
export { BOARD };

export const BOARD_VERSION = 1;
export const BOARD_ACK = JSON.stringify({ type: 'pr-board.ack', version: BOARD_VERSION });
export const SECTION = 'pr-board.section';
export const EVENTS = 'pr-board.events';
export const ROWS_PER_PART = 12;
export const MAX_PARTS = 128;
export const EVENTS_PER_PACKET = 12;
const PACKET_BYTES = 15_000;
export const STALE_MS = 5 * 60_000;
export const PUBLISH_MS = 120_000;
export const PASS_MS = 2000;
export const DOOR_INTERVAL_MS = 15_000;
export const DISCORD_INTERVAL_MS = 2000;
export const DISCORD_LIMIT = 2000;
export const DIGEST = /^[a-f0-9]{64}$/;
export const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
export const VERDICTS = ['PASS', 'PASS+NOTES', 'FAIL'];
const STATES = ['draft', 'ready', 'factory-review', 'waiting', 'blocked', 'merged-today'];
export const FACTORY_STOP = ['held', 'checks-missing', 'checks-failed', 'failed', 'refused', 'escalated'];
export const FACTORY_REVIEW = ['checked', 'conflict', 'judged'];
export const FACTORY_STAGES = [...FACTORY_STOP, ...FACTORY_REVIEW, 'resolved', 'merged'];
const CHECK_STATES = ['passed', 'failed', 'missing', 'not-run'];
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const utcDay = at => new Date(at).toISOString().slice(0, 10);
export const pullLink = pull => `https://github.com/${pull.repository}/pull/${pull.number}`;
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value < maximum;
const bounded = (value, size) => typeof value === 'string' && value.length > 0 && value.length <= size;
const unique = values => new Set(values).size === values.length;
const requireShape = (valid, message) => { if (!valid) throw new Error(message); };

function fields(value, allowed, required = allowed) {
  requireShape(value && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  requireShape(Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'unexpected or missing fields');
}

function pullOf(pull) {
  const required = ['repository', 'number', 'title', 'workers', 'githubState', 'state', 'createdAt'];
  fields(pull, [...required, 'mergedAt', 'evidence', 'factory', 'blockedUntil'], required);
  requireShape(typeof pull.repository === 'string' && REPOSITORY.test(pull.repository) && Number.isSafeInteger(pull.number) && integer(pull.number - 1, 1_000_000_000), 'invalid pull identity');
  requireShape(bounded(pull.title, 256) && Array.isArray(pull.workers) && pull.workers.length <= 8 && pull.workers.every(title => bounded(title, 96)), 'invalid display text');
  requireShape(STATES.includes(pull.state) && ['draft', 'ready', 'merged'].includes(pull.githubState) && time(pull.createdAt), 'invalid pull state or age');
  mergeOf(pull);
  evidenceOf(pull);
  if (pull.factory !== undefined) {
    fields(pull.factory, ['stage', 'checks']);
    requireShape(FACTORY_STAGES.includes(pull.factory.stage) && CHECK_STATES.includes(pull.factory.checks), 'invalid Factory facts');
  }
  requireShape(pull.blockedUntil === undefined || (pull.githubState === 'draft' && isCalendarDay(pull.blockedUntil)), 'invalid draft hold');
}

function mergeOf(pull) {
  if (pull.githubState === 'merged') {
    requireShape(pull.state === 'merged-today' && time(pull.mergedAt), 'invalid merge');
    return;
  }
  requireShape(pull.mergedAt === undefined && pull.state !== 'merged-today', 'unexpected merge');
}

function evidenceOf(pull) {
  if (['draft', 'ready', 'merged-today'].includes(pull.state)) {
    requireShape(pull.evidence === undefined && (pull.state === 'merged-today' || pull.githubState === pull.state), 'state differs from GitHub');
    return;
  }
  fields(pull.evidence, ['kind']);
  const kinds = { waiting: ['human-dialog'], blocked: ['worker-hold', 'factory-stop'], 'factory-review': ['factory-review'] };
  requireShape(kinds[pull.state].includes(pull.evidence.kind) && pull.githubState !== 'merged', 'evidence differs from state');
}

export function eventOf(event) {
  const required = ['id', 'repository', 'number', 'kind', 'at'];
  fields(event, [...required, 'verdict'], required);
  requireShape(DIGEST.test(event.id) && REPOSITORY.test(event.repository) && Number.isSafeInteger(event.number) && integer(event.number - 1, 1_000_000_000) && time(event.at), 'invalid event');
  requireShape(['merge', 'verdict'].includes(event.kind), 'unknown event kind');
  requireShape(event.kind === 'verdict' ? VERDICTS.includes(event.verdict) : event.verdict === undefined, 'invalid verdict');
  return event;
}

export function boardPacket(need) {
  try {
    requireShape(typeof need === 'string' && Buffer.byteLength(need) <= PACKET_BYTES, 'packet too large');
    const packet = JSON.parse(need);
    requireShape(packet?.version === BOARD_VERSION, 'unknown version');
    if (packet.type === EVENTS) {
      fields(packet, ['type', 'version', 'events']);
      requireShape(Array.isArray(packet.events) && packet.events.length > 0 && packet.events.length <= EVENTS_PER_PACKET, 'invalid event count');
      packet.events.forEach(eventOf);
      requireShape(unique(packet.events.map(event => event.id)), 'duplicate events');
      return packet;
    }
    fields(packet, ['type', 'version', 'snapshot', 'publishedAt', 'part', 'parts', 'pulls']);
    requireShape(packet.type === SECTION && DIGEST.test(packet.snapshot) && time(packet.publishedAt), 'invalid snapshot');
    requireShape(integer(packet.parts - 1, MAX_PARTS) && integer(packet.part, packet.parts), 'invalid part count');
    requireShape(Array.isArray(packet.pulls) && packet.pulls.length <= ROWS_PER_PART, 'invalid pull count');
    packet.pulls.forEach(pullOf);
    return packet;
  } catch (cause) {
    throw new Refusal(`pots: invalid board packet: ${cause.message}`);
  }
}

export function boardRoute(packet, caller, configuration, isMastermind) {
  if (configuration?.enabled !== true || !isMastermind || !isPotName(caller)) throw new Refusal('pots: board receiver is disabled or has the wrong direction.');
  const repositories = configuration.sources?.[caller];
  if (!Array.isArray(repositories) || !repositories.every(repository => REPOSITORY.test(repository))) throw new Refusal('pots: no private repository grant for this board source.');
  const rows = packet.type === SECTION ? packet.pulls : packet.events;
  if (rows.some(row => !repositories.includes(row.repository))) throw new Refusal('pots: board repository is outside the source grant.');
}

export function checkBoardReply(reply) {
  if (reply !== BOARD_ACK) throw new Refusal('pots: a board delivery takes only its exact acknowledgement.');
}

export function sectionPackets(pulls, publishedAt) {
  if (pulls.length > ROWS_PER_PART * MAX_PARTS) throw new Error('pr-board: snapshot exceeds the complete-publication limit.');
  const section = { type: SECTION, version: BOARD_VERSION, snapshot: digest(pulls), publishedAt };
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...section, part: MAX_PARTS - 1, parts: MAX_PARTS, pulls: [] }));
  const chunks = [[]];
  let bytes = envelopeBytes;
  for (const pull of pulls) {
    pullOf(pull);
    const size = Buffer.byteLength(JSON.stringify(pull));
    const chunk = chunks.at(-1);
    if (chunk.length >= ROWS_PER_PART || bytes + size + Number(chunk.length > 0) > PACKET_BYTES) {
      chunks.push([]);
      bytes = envelopeBytes;
    }
    bytes += size + Number(chunks.at(-1).length > 0);
    chunks.at(-1).push(pull);
  }
  if (chunks.length > MAX_PARTS) throw new Error('pr-board: snapshot exceeds the complete-publication limit.');
  return chunks.map((rows, part) => boardPacket(JSON.stringify({ ...section, part, parts: chunks.length, pulls: rows })));
}
