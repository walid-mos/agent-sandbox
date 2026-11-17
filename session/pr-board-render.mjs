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
  const plain = `GitHub ${pull.githubState}`;
  const status = LABELS[pull.state] ? `${plain} · ${LABELS[pull.state]} / ${pull.evidence.kind}` : plain;
  const state = pull.state === 'merged-today' ? 'merged today UTC' : status;
  return `#${pull.number} ${displayText(pull.title)} · ${displayText(pot)} / ${who} · ${state} · ${age(pull.createdAt, now)}\n<${pullLink(pull)}>`;
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
  for (const [repository, pulls] of [...repositories].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push('', displayText(repository), ...pulls.sort((left, right) => left.pull.number - right.pull.number).map(({ pot, pull }) => row(pot, pull, now)));
  }
  if (!repositories.size) lines.push('No current pull requests.');
  return paginate(lines);
}

export function renderEvent({ pot, claim }) {
  const description = claim.kind === 'merge' ? 'a merge' : `factory verdict ${displayText(claim.verdict)}`;
  return `${displayText(pot)} reports ${description} · ${displayText(claim.repository)} #${claim.number} · ${new Date(claim.at).toISOString()}\n<${pullLink(claim)}>`;
}
