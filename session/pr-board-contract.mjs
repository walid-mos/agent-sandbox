import { createHash } from 'node:crypto';
import { BOARD, isPotName, Refusal } from './door-messages.mjs';
export { BOARD };

export const BOARD_VERSION = 1;
export const BOARD_ACK = JSON.stringify({ type: 'pr-board.ack', version: BOARD_VERSION });
export const SECTION = 'pr-board.section';
export const EVENTS = 'pr-board.events';
export const ROWS_PER_PART = 12;
export const MAX_PARTS = 128;
export const EVENTS_PER_PACKET = 12;
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
const EVIDENCE = ['human-dialog', 'worker-hold', 'factory-stop', 'factory-review'];
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
  fields(pull, [...required, 'mergedAt', 'evidence'], required);
  requireShape(REPOSITORY.test(pull.repository) && Number.isSafeInteger(pull.number) && integer(pull.number - 1, 1_000_000_000), 'invalid pull identity');
  requireShape(bounded(pull.title, 256) && Array.isArray(pull.workers) && pull.workers.length <= 8 && pull.workers.every(title => bounded(title, 96)), 'invalid display text');
  requireShape(STATES.includes(pull.state) && ['draft', 'ready', 'merged'].includes(pull.githubState) && time(pull.createdAt), 'invalid pull state or age');
  mergeOf(pull);
  evidenceOf(pull);
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
  fields(pull.evidence, ['kind', 'id']);
  requireShape(EVIDENCE.includes(pull.evidence.kind) && bounded(pull.evidence.id, 128), 'invalid evidence');
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
    requireShape(typeof need === 'string' && Buffer.byteLength(need) <= 15_000, 'packet too large');
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
  const parts = Math.max(1, Math.ceil(pulls.length / ROWS_PER_PART));
  return Array.from({ length: parts }, (_, part) => boardPacket(JSON.stringify({ type: SECTION, version: BOARD_VERSION,
    snapshot: digest(pulls), publishedAt, part, parts, pulls: pulls.slice(part * ROWS_PER_PART, (part + 1) * ROWS_PER_PART) })));
}
