import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buttonId, verifyOffer, verifyPress } from '../mac/launch-approval.mjs';
import { launchNotice, launchRequest, shownRequest } from '../session/launch-contract.mjs';
import { application, now, pressEvent, settings, snowflake } from './fixtures/mac-launch.mjs';

const { guildId: guild, channelId: channel, humanDiscord: { userId: operator } } = settings;
const message = '444444444444444444';
const request = launchRequest({ launch: 'a'.repeat(32), target: 'mac-studio', pot: 'alpha', title: 'Reply', prompt: 'Reply ready.', createdAt: now });
const offer = { request, prompt: 'Reply ready.', content: 'Approve this prompt', messageId: message, applicationId: application, attachment: { id: '666666666666666666', filename: 'prompt.txt', size: 12 } };
const click = () => pressEvent(offer, now);

test('only the enabled operator may approve the gate message', () => {
  const event = click();
  event.member.user.id = '777777777777777777';
  assert.throws(() => verifyPress(event, offer, settings, now, 'ml'), /operator/);
});

test('an authentic fresh press binds the whole approval to this offer', () => {
  const approved = verifyPress(click(), offer, settings, now, 'ml');
  assert.equal(approved.digest, request.digest);
  assert.equal(approved.target, 'mac-studio');
  assert.equal(approved.pot, 'alpha');
  assert.equal(approved.userId, operator);
  assert.equal(approved.messageUrl, `https://discord.com/channels/${guild}/${channel}/${message}`);
});

const attacks = {
  'another message': e => { e.message.id = '777777777777777777'; },
  'another application': e => { e.application_id = '777777777777777777'; },
  'another guild': e => { e.guild_id = '777777777777777777'; },
  'another channel': e => { e.channel_id = '777777777777777777'; },
  'edited message': e => { e.message.edited_timestamp = '2026-11-17T20:00:00Z'; },
  'swapped text': e => { e.message.content = 'Different text'; },
  'swapped attachment': e => { e.message.attachments = []; },
  'another digest': e => { e.data.custom_id = `ml:${request.launch}:${'b'.repeat(64)}`; },
  'refusal as approval': e => { e.data.custom_id = buttonId(request, 'mx'); },
  'stale press': e => { e.id = snowflake(now - 30_001); },
  'future press': e => { e.id = snowflake(now + 5001); },
};
for (const [name, attack] of Object.entries(attacks)) test(`rejects ${name}`, () => {
  const event = click();
  attack(event);
  assert.throws(() => verifyPress(event, offer, settings, now, 'ml'));
});

test('a Mac clock that trails Discord or the pot by a few seconds still accepts', () => {
  const event = click();
  event.id = snowflake(now + 5000);
  assert.equal(verifyPress(event, offer, settings, now, 'ml').launch, request.launch);
  assert.equal(verifyOffer(shownRequest(request, offer.prompt, 'open'), launchNotice(request), settings, now - 5000).request.launch, request.launch);
});

test('the private switch and expiry are rechecked at the press', () => {
  assert.throws(() => verifyPress(click(), offer, { ...settings, humanDiscord: { ...settings.humanDiscord, macLaunchEnabled: false } }, now, 'ml'), /off|enabled/);
  assert.throws(() => verifyPress(click(), offer, settings, request.expiresAt, 'ml'), /expired|old/);
});

test('the gate refuses a changed source, target, future or forbidden scope', () => {
  const shown = shownRequest(request, offer.prompt, 'open');
  assert.equal(verifyOffer(shown, launchNotice(request), settings, now).request.launch, request.launch);
  for (const changes of [{ state: 'superseded' }, { target: 'macbook-pro' }, { prompt: 'Other bytes.' }, { state: 'cancelled' }]) {
    assert.throws(() => verifyOffer({ ...shown, ...changes }, launchNotice(request), settings, now));
  }
  assert.throws(() => verifyOffer(shown, launchNotice(request), settings, now - 5001));
  const signed = launchRequest({ ...request, prompt: 'Sign the tip.', acts: ['sign-tip'] });
  assert.throws(() => verifyOffer(shownRequest(signed, 'Sign the tip.', 'open'), launchNotice(signed), settings, now), /refuses sign-tip/);
});
