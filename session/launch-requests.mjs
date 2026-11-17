import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { checkedStatus, launchRequest, launchStatus, OFFERED, OPEN, shownRequest } from './launch-contract.mjs';

const LAUNCH_ID_BYTES = 16;
const EXPIRED = 'expired';
const LIVE = [OPEN, OFFERED];

export const launchStore = () => humanStore(join(HUMAN_HOME, 'launch'));

export function launchSettings(sandbox) {
  const settings = sandbox.macLaunch;
  if (settings?.enabled !== true) throw new Error('mac-launch: Mac launches are off in this pot. Its sandbox.json holds no macLaunch with enabled set to true.');
  return settings;
}

function known(get, id) {
  const record = get(id);
  if (!record) throw new Error('mac-launch: this pot holds no such launch. mac-launch.mjs list names them.');
  return record;
}

const statusReport = (status, request) => ({ ...status, title: request.title });
// The wake carries an ID, so the same status sent twice, by the gate or by expiry, wakes the bot once.
export const botWake = (report, bot) => ['wake', '--bot', bot, '--from', 'mac-launch', '--id', `mac-launch-${report.launch}-${report.status}`, '--note', JSON.stringify(report)];

const stateAt = (record, now) => (LIVE.includes(record.state) && now >= record.request.expiresAt ? EXPIRED : record.state);

export async function openLaunch({ target, title, acts, cost, prompt }, { store, settings, pot, now = Date.now() }) {
  const targets = Object.keys(settings.targets ?? {});
  if (!targets.includes(target)) throw new Error(`mac-launch: this pot knows no Mac named ${target}. Its targets: ${targets.join(', ') || 'none'}.`);
  const request = launchRequest({ launch: randomBytes(LAUNCH_ID_BYTES).toString('hex'), pot, target, title, acts, cost, createdAt: now, prompt });
  await store.locked(({ save }) => save({ id: request.launch, request, prompt, state: OPEN, statuses: [] }), request.launch);
  return request;
}

export async function retireLaunch(id, state, store, now = Date.now()) {
  return store.locked(({ get, save }) => {
    const record = known(get, id);
    const current = stateAt(record, now);
    if (!LIVE.includes(current)) throw new Error(`mac-launch: this launch is already ${current}, so it cannot become ${state}.`);
    return save({ ...record, state }).request;
  }, id);
}

export function shownLaunch(id, store, now = Date.now()) {
  const record = known(store.get, id);
  const state = stateAt(record, now);
  return shownRequest(record.request, record.prompt, LIVE.includes(state) ? OPEN : state);
}

// A press may precede cancellation, so a later start report still counts.
export async function recordStatus(candidate, store) {
  const status = checkedStatus(candidate);
  return store.locked(({ get, save }) => {
    const record = known(get, status.launch);
    if (record.request.digest !== status.digest || record.request.target !== status.target) throw new Error('mac-launch: this status names another prompt or another Mac than the launch this pot holds.');
    const report = statusReport(status, record.request);
    if (record.statuses.some(seen => seen.status === status.status)) return report;
    const state = status.status === OFFERED && record.state !== OPEN ? record.state : status.status;
    save({ ...record, state, statuses: [...record.statuses, status] });
    return report;
  }, status.launch);
}

export async function expireLaunches(store, notify, now = Date.now()) {
  for (const record of store.all()) {
    const id = record.id;
    const expired = await store.locked(({ get, save }) => {
      const current = get(id);
      if (stateAt(current, now) !== EXPIRED || current.expiryNotified) return undefined;
      return save({ ...current, state: EXPIRED });
    }, id);
    if (!expired) continue;
    await notify(statusReport(launchStatus({ ...expired.request, status: EXPIRED }), expired.request));
    await store.patch(id, { expiryNotified: true });
  }
}

export function listedLaunches(store, now = Date.now()) {
  return store.all().sort((first, second) => first.request.createdAt - second.request.createdAt)
    .map(({ request, ...record }) => ({ launch: request.launch, target: request.target, title: request.title, state: stateAt({ request, ...record }, now), statuses: record.statuses.map(status => status.status) }));
}
