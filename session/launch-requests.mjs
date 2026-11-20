import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { checkedStatus, EXPIRED, launchRequest, launchStatus, OFFERED, OPEN, shownRequest, STARTED } from './launch-contract.mjs';
import { command } from './run.mjs';

const LAUNCH_ID_BYTES = 16;
const LIVE = [OPEN, OFFERED];
// A Mac may claim a launch until its last moment and report the start a little later, so the pot waits this long before it tells its bot the launch expired.
const EXPIRY_GRACE_MS = 60_000;
const EXPIRED_UNHEARD = 'No Mac reported a start before this request expired. A Mac refuses a press after the expiry by its own clock. A start it committed just before still reports, and that report stands.';

export const launchStore = () => humanStore(join(HUMAN_HOME, 'launch'));

function known(get, id) {
  const record = get(id);
  if (!record) throw new Error('mac-launch: this pot holds no such launch. mac-launch.mjs list names them.');
  return record;
}

// A start the Mac committed before it heard this pot's closure stands, and the report names the closure that came too late.
const overtaken = (status, record) => (status.status === STARTED ? record.asked ?? (record.state === EXPIRED ? EXPIRED : undefined) : undefined);
const statusReport = (status, record) => ({ ...status, title: record.request.title, tooLate: overtaken(status, record) });
// The wake carries an ID, so the same status sent twice, by the gate or by expiry, wakes the bot once.
export const wakeBot = (report, bot) => command('pots', ['wake', '--bot', bot, '--from', 'mac-launch', '--id', `mac-launch-${report.launch}-${report.status}`, '--note', JSON.stringify(report)]);

const stateAt = (record, now) => (LIVE.includes(record.state) && now >= record.request.expiresAt ? EXPIRED : record.state);

export async function openLaunch({ target, title, acts, cost, prompt }, { store, settings, pot, now = Date.now() }) {
  const targets = Object.keys(settings?.targets ?? {});
  if (!targets.includes(target)) throw new Error(`mac-launch: this pot knows no Mac named ${target}. Its targets: ${targets.join(', ') || 'none'}.`);
  const request = launchRequest({ launch: randomBytes(LAUNCH_ID_BYTES).toString('hex'), pot, target, title, acts, cost, createdAt: now, prompt });
  await store.locked(({ save }) => save({ id: request.launch, request, prompt, state: OPEN, statuses: [] }), request.launch);
  return request;
}

// A pot only asks. The launch is closed once the Mac reports it closed, and a Mac that claimed it first reports its start instead.
export async function askClosure(id, state, store, now = Date.now()) {
  return store.locked(({ get, save }) => {
    const record = known(get, id);
    const current = stateAt(record, now);
    if (!LIVE.includes(current)) throw new Error(`mac-launch: this launch is already ${current}, so it cannot become ${state}.`);
    if (record.asked) throw new Error(`mac-launch: this launch already waits for the Mac to confirm it is ${record.asked}.`);
    return save({ ...record, asked: state }).request;
  }, id);
}

export function shownLaunch(id, store, now = Date.now()) {
  const record = known(store.get, id);
  const state = stateAt(record, now);
  return shownRequest(record.request, record.prompt, LIVE.includes(state) ? record.asked ?? OPEN : state);
}

export async function recordStatus(candidate, store) {
  const status = checkedStatus(candidate);
  return store.locked(({ get, save }) => {
    const record = known(get, status.launch);
    if (record.request.digest !== status.digest || record.request.target !== status.target) throw new Error('mac-launch: this status names another prompt or another Mac than the launch this pot holds.');
    const report = statusReport(status, record);
    if (record.statuses.some(seen => seen.status === status.status)) return report;
    const state = status.status === OFFERED && record.state !== OPEN ? record.state : status.status;
    save({ ...record, state, statuses: [...record.statuses, status] });
    return report;
  }, status.launch);
}

export async function expireLaunches(store, notify, now = Date.now()) {
  for (const record of store.all()) {
    if (stateAt(record, now - EXPIRY_GRACE_MS) !== EXPIRED || record.expiryNotified) continue;
    const id = record.id;
    const expired = await store.locked(({ get, save }) => {
      const current = get(id);
      if (stateAt(current, now - EXPIRY_GRACE_MS) !== EXPIRED || current.expiryNotified) return undefined;
      return save({ ...current, state: EXPIRED });
    }, id);
    if (!expired) continue;
    await notify(statusReport(launchStatus({ ...expired.request, status: EXPIRED, detail: EXPIRED_UNHEARD }), expired));
    await store.patch(id, { expiryNotified: true });
  }
}

export function listedLaunches(store, now = Date.now()) {
  return store.all().sort((first, second) => first.request.createdAt - second.request.createdAt)
    .map(record => ({ launch: record.request.launch, target: record.request.target, title: record.request.title, state: stateAt(record, now), asked: record.asked, statuses: record.statuses.map(status => status.status) }));
}
