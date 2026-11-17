import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gateStore } from '../../mac/launch-store.mjs';
import { launchService } from '../../mac/launch-service.mjs';
import { buttonId } from '../../mac/launch-approval.mjs';
import { launchNotice, launchRequest, noticeText, shownRequest } from '../../session/launch-contract.mjs';

export const now = 1794945000000;
export const settings = { name: 'mac-studio', label: 'Mac Studio', pots: ['alpha'], refusedActs: ['sign-tip', 'launch-gate'],
  guildId: '222222222222222222', channelId: '333333333333333333', announcers: ['888888888888888888'], directory: tmpdir(), piArguments: [],
  humanDiscord: { userId: '111111111111111111', macLaunchEnabled: true } };
export const application = '555555555555555555';
export const snowflake = at => ((BigInt(at) - 1420070400000n) << 22n).toString();

export function ownedFolder(t) {
  const folder = mkdtempSync(join(tmpdir(), 'mac-launch-probe-'));
  const owner = randomUUID();
  const marker = join(folder, '.owner');
  writeFileSync(marker, owner);
  t.after(() => { if (readFileSync(marker, 'utf8') === owner) rmSync(folder, { recursive: true }); });
  return folder;
}

export function scenario(t) {
  const store = gateStore(ownedFolder(t));
  const prompt = 'Reply ready.';
  const request = launchRequest({ launch: 'a'.repeat(32), pot: 'alpha', target: 'mac-studio', title: 'Reply', createdAt: now, prompt });
  const notice = { id: '999999999999999999', channel_id: settings.channelId, guild_id: settings.guildId, author: { id: settings.announcers[0] }, content: noticeText(launchNotice(request)) };
  const posted = [];
  const edits = [];
  const reports = [];
  const runs = [];
  const told = [];
  const source = { shown: shownRequest(request, prompt, 'open'), config: structuredClone(settings), time: now, result: undefined, isReportBroken: false };
  const discord = { post: async (channel, payload, bytes) => {
    posted.push({ channel, payload, bytes });
    return { id: '444444444444444444', attachments: [{ id: '666666666666666666', filename: payload.attachments[0].filename, size: Buffer.byteLength(bytes) }] };
  }, edit: async (...args) => edits.push(args), tell: async (event, content) => told.push(content) };
  const pots = { show: async () => structuredClone(source.shown), report: async (pot, packet) => {
    if (source.isReportBroken) throw new Error('offline');
    reports.push({ pot, packet });
  } };
  const runner = { start: offer => {
    runs.push(offer.prompt);
    return { name: 'stand-in' };
  }, result: () => source.result };
  const dependencies = { store, discord, pots, runner, settings: () => source.config, warn: () => {}, clock: () => source.time };
  const service = launchService(dependencies);
  const press = (action = 'ml') => {
    const offer = store.get(request.launch);
    return { type: 3, id: snowflake(source.time), application_id: application, guild_id: settings.guildId, channel_id: settings.channelId,
      member: { user: { id: settings.humanDiscord.userId } }, data: { component_type: 2, custom_id: buttonId(request, action) },
      message: { id: offer.messageId, author: { id: application }, content: offer.content, edited_timestamp: null, attachments: [offer.attachment] } };
  };
  return { service, dependencies, store, source, notice, request, posted, edits, reports, runs, told, press };
}
