import { discordMessageUrl } from '../session/human-contract.mjs';
import { launchStatus, noticeOf, OFFERED } from '../session/launch-contract.mjs';
import { verifyOffer, verifyPress } from './launch-approval.mjs';
import { closedMessage, offerMessage } from './launch-messages.mjs';

export function launchService({ store, discord, pots, runner, settings, clock = Date.now }) {
  const messageUrl = offer => discordMessageUrl({ guildId: offer.guildId, channelId: offer.channelId, messageId: offer.messageId });
  const saveState = (offer, state, details = {}) => {
    const status = launchStatus({ ...offer.request, status: state, messageUrl: messageUrl(offer), ...details });
    return store.save({ ...offer, state, ...details, needsEdit: state !== OFFERED, pending: [...offer.pending, status] });
  };

  async function notice(message, applicationId) {
    const config = settings();
    if (config.humanDiscord.macLaunchEnabled !== true || message.guild_id !== config.guildId || message.channel_id !== config.channelId
      || !config.announcers.includes(message.author?.id)) return;
    let proposed;
    try { proposed = noticeOf(message.content); } catch { return; }
    if (proposed.target !== config.name || !config.pots.includes(proposed.pot)) return;
    const known = store.get(proposed.launch);
    if (known) return refresh(known);
    if (store.used(proposed.launch)) return;
    const shown = await pots.show(proposed.pot, proposed.launch);
    const verified = verifyOffer(shown, proposed, settings(), clock());
    const payload = offerMessage(verified, config, discordMessageUrl({ guildId: message.guild_id, channelId: message.channel_id, messageId: message.id }));
    const posted = await discord.post(config.channelId, payload, verified.prompt);
    const offer = { ...verified, content: payload.content, guildId: config.guildId, channelId: config.channelId, applicationId,
      messageId: posted.id, attachment: posted.attachments[0], state: OFFERED, pending: [] };
    saveState(offer, OFFERED);
  }

  async function refresh(offer) {
    if (offer.state !== OFFERED) return;
    if (store.used(offer.request.launch)) { saveState(offer, 'failed', { detail: 'Gate stopped after consuming the approval. It will never relaunch it.' }); return; }
    if (clock() >= offer.request.expiresAt) { saveState(offer, 'expired'); return; }
    let shown;
    try { shown = await pots.show(offer.request.pot, offer.request.launch); }
    catch { saveState(offer, 'failed', { detail: 'The source is unavailable. Ask for a new prompt.' }); return; }
    if (shown.state !== 'open') { saveState(offer, ['cancelled', 'superseded', 'expired'].includes(shown.state) ? shown.state : 'failed'); return; }
    try { verifyOffer(shown, offer.request, settings(), clock()); }
    catch { saveState(offer, 'superseded', { detail: 'The source changed or this Mac now refuses the request.' }); }
  }

  async function press(event) {
    const custom = event.data?.custom_id ?? '';
    const [action, id] = custom.split(':');
    if (!['ml', 'mx'].includes(action) || !/^[a-f0-9]{32}$/.test(id)) return;
    const offer = store.get(id);
    if (!offer || offer.state !== OFFERED || store.used(id)) return;
    let approval = verifyPress(event, offer, settings(), clock(), action);
    await discord.acknowledge(event);
    let shown;
    try { shown = await pots.show(offer.request.pot, id); }
    catch { saveState(offer, 'failed', { detail: 'The source is unavailable. Ask for a new prompt.' }); return; }
    try { verifyOffer(shown, offer.request, settings(), clock()); }
    catch { saveState(offer, 'superseded'); return; }
    approval = verifyPress(event, offer, settings(), clock(), action);
    store.consume(approval);
    if (action === 'mx') { saveState(offer, 'refused'); return; }
    try {
      const run = runner.start(offer, settings());
      saveState({ ...offer, run }, 'started');
    } catch {
      saveState(offer, 'failed', { detail: 'Pi did not start. This approval is used. Inspect Herdr before asking again.' });
    }
  }

  async function deliver(offer) {
    if (offer.needsEdit) {
      await discord.edit(offer.channelId, offer.messageId, closedMessage(offer));
      offer = store.save({ ...offer, needsEdit: false });
    }
    while (offer.pending.length) {
      await pots.report(offer.request.pot, offer.pending[0]);
      offer = store.save({ ...offer, pending: offer.pending.slice(1) });
    }
  }

  async function tick() {
    for (const offer of store.all()) {
      try {
        await refresh(offer);
        const latest = store.get(offer.request.launch);
        if (latest.state === 'started') {
          const result = runner.result(latest.run);
          if (result) saveState(latest, result.status, result);
        }
        await deliver(store.get(offer.request.launch));
      } catch {
        discord.warn('A launch refresh or delivery failed. It will retry.');
      }
    }
  }
  return { notice, press, tick };
}
