import { DISCORD_LIMIT, pullLink, STALE_MS, utcDay } from './pr-board-contract.mjs';

const PAGE_CONTENT_LIMIT = DISCORD_LIMIT - 300;
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_HOURS = 24;
const LABELS = { 'factory-review': 'in factory review', waiting: 'waiting for Walid', blocked: 'blocked' };

export function displayText(text, limit = 128) {
  return `${text}`.replace(/(?:[a-z][\w+.-]*:\/\/|www\.)\S+/gi, '')
    .replace(/[^\p{L}\p{M}\p{N} ,/+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || 'untitled';
}

function age(createdAt, now) {
  const minutes = Math.max(0, Math.floor((now - createdAt) / MINUTE_MS));
  if (minutes < HOUR_MINUTES) return `${minutes}m`;
  const hours = Math.floor(minutes / HOUR_MINUTES);
  return hours < DAY_HOURS ? `${hours}h` : `${Math.floor(hours / DAY_HOURS)}d`;
}

function row(pot, pull, now) {
  const who = pull.workers.length ? pull.workers.map(title => displayText(title, 72)).join(', ') : 'unassigned';
  const status = [pull.state === 'merged-today' ? 'merged today UTC' : `GitHub ${pull.githubState}`];
  if (LABELS[pull.state]) status.push(`${LABELS[pull.state]} (${pull.evidence.kind})`);
  if (pull.factory) status.push(`Factory ${pull.factory.stage}`);
  status.push(`checks ${pull.factory?.checks ?? 'unreported'}`);
  if (pull.blockedUntil && pull.blockedUntil > utcDay(now)) status.push(`author hold until ${pull.blockedUntil} UTC`);
  return [
    `\`${pull.repository}\` #${pull.number} ${displayText(pull.title)}`,
    status.join(' · '),
    `${displayText(pot)} / ${who} · ${age(pull.createdAt, now)} · <${pullLink(pull)}>`,
  ].join('\n');
}

function sectionRows(state, configuration, now) {
  const statuses = [];
  const repositories = new Map();
  for (const [pot, grants] of Object.entries(configuration.sources)) {
    const current = state.sources[pot]?.current;
    if (!current || now - current.publishedAt > STALE_MS) {
      statuses.push(`${displayText(pot)} · ${current ? `stale · last update ${new Date(current.publishedAt).toISOString()}` : 'awaiting first update'}`);
      continue;
    }
    statuses.push(`${displayText(pot)} · updated ${new Date(current.publishedAt).toISOString()}`);
    const shown = current.pulls.filter(pull => grants.includes(pull.repository) && (!pull.mergedAt || utcDay(pull.mergedAt) === utcDay(now)));
    for (const pull of shown) repositories.set(pull.repository, [...(repositories.get(pull.repository) ?? []), { pot, pull }]);
  }
  return { statuses, repositories };
}

function paginate(lines) {
  const pages = [];
  let page = '';
  for (const line of lines) {
    if (page.length + line.length + 1 > PAGE_CONTENT_LIMIT) {
      pages.push(page);
      page = '';
    }
    page += `${page ? '\n' : ''}${line}`;
  }
  if (page) pages.push(page);
  return pages;
}

export function boardSummary(state, configuration, now) {
  return ['Pull requests · merged today uses UTC', 'Pot-reported GitHub state and local facts', ...sectionRows(state, configuration, now).statuses].join('\n');
}

export function renderBoard(state, configuration, now) {
  const { statuses, repositories } = sectionRows(state, configuration, now);
  const lines = ['Pull requests · merged today uses UTC', 'Pot-reported GitHub state and local facts', ...statuses];
  for (const [, pulls] of [...repositories].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push('', ...pulls.sort((left, right) => left.pull.number - right.pull.number).map(({ pot, pull }) => row(pot, pull, now)));
  }
  if (!repositories.size) lines.push('No current pull requests.');
  return paginate(lines);
}

export function renderEvent({ pot, claim }) {
  const description = claim.kind === 'merge' ? 'a merge' : `factory verdict ${displayText(claim.verdict)}`;
  return `${displayText(pot)} reports ${description} · ${displayText(claim.repository)} #${claim.number} · ${new Date(claim.at).toISOString()}\n<${pullLink(claim)}>`;
}
