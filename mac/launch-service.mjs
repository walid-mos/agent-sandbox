import { discordMessageUrl } from '../session/human-contract.mjs';
import { launchStatus, noticeOf, OFFERED, OPEN } from '../session/launch-contract.mjs';
import { boundRequest, BUTTON, CLAIMED, pressedButton, verifyOffer, verifyPress } from './launch-approval.mjs';
import { closedMessage, offerMessage } from './launch-messages.mjs';

const STARTED = 'started';
const SOURCE_CLOSURES = ['cancelled', 'superseded', 'expired'];
const UNACCOUNTED_CLAIM = 'The gate stopped after it claimed this approval and before it recorded a start. A Pi may be running: inspect the ml- terminals in Herdr. The gate never launches this approval again.';
const SOURCE_SILENT = 'The requesting pot did not answer, so nothing started and this press is not used. Press again once the pot answers.';

export function launchService({ store, discord, pots, runner, settings, warn, clock = Date.now }) {
  const messageUrl = offer => (offer.messageId ? discordMessageUrl({ guildId: offer.guildId, channelId: offer.channelId, messageId: offer.messageId }) : undefined);
  const saveState = (offer, state, details = {}) => {
    const status = launchStatus({ ...offer.request, status: state, messageUrl: messageUrl(offer), ...details });
    return store.save({ ...offer, state, ...details, needsEdit: Boolean(offer.messageId) && state !== OFFERED, pending: [...offer.pending, status] });
  };
  // A launch leaves the offered state once, through the Mac's decision file. A claim and a closure race for that file, and the loser changes nothing.
  const decide = (offer, state, evidence = {}) => store.decide(offer.request.launch, { state, decidedAt: clock(), ...evidence });
  function close(offer, state, { details, evidence } = {}) {
    decide(offer, state, evidence);
    return saveState(offer, state, details);
  }

  // A gate that stopped between its decision and its record finishes the record from the decision. A claim it cannot account for never launches again.
  function recover(offer) {
    const decided = store.decision(offer.request.launch);
    if (!decided) return false;
    if (decided.state === CLAIMED) saveState(offer, 'failed', { detail: UNACCOUNTED_CLAIM });
    else saveState(offer, decided.state);
    return true;
  }

  // The pot's answer can only close a launch here. An unreachable pot throws, and the Mac's own record stands.
  async function sourceClosure(offer) {
    const shown = await pots.show(offer.request.pot, offer.request.launch);
    if (shown.state !== OPEN) return { state: SOURCE_CLOSURES.includes(shown.state) ? shown.state : 'failed' };
    try { verifyOffer(shown, offer.request, settings(), clock()); }
    catch { return { state: 'superseded', details: { detail: 'The source changed or this Mac now refuses the request.' } }; }
    return undefined;
  }

  // A pot may close a launch this Mac never offered. The Mac records that too, so the closure the pot hears is one the Mac holds to.
  function closeUnoffered(shown, proposed) {
    const { request, state } = boundRequest(shown, proposed, settings());
    close({ request, pending: [] }, state);
  }

  async function notice(message, applicationId) {
    const config = settings();
    if (config.humanDiscord.macLaunchEnabled !== true || message.guild_id !== config.guildId || message.channel_id !== config.channelId
      || !config.announcers.includes(message.author?.id)) return;
    let proposed;
    try { proposed = noticeOf(message.content); } catch { return; }
    if (proposed.target !== config.name || !config.pots.includes(proposed.pot)) return;
    const known = store.get(proposed.launch);
    if (known) return refresh(known);
    if (store.decision(proposed.launch)) return;
    const shown = await pots.show(proposed.pot, proposed.launch);
    if (SOURCE_CLOSURES.includes(shown.state)) return closeUnoffered(shown, proposed);
    const verified = verifyOffer(shown, proposed, settings(), clock());
    const payload = offerMessage(verified, config, discordMessageUrl({ guildId: message.guild_id, channelId: message.channel_id, messageId: message.id }));
    const posted = await discord.post(config.channelId, payload, verified.prompt);
    const offer = { ...verified, content: payload.content, guildId: config.guildId, channelId: config.channelId, applicationId,
      messageId: posted.id, attachment: posted.attachments[0], state: OFFERED, pending: [] };
    saveState(offer, OFFERED);
  }

  async function refresh(offer) {
    if (offer.state !== OFFERED || recover(offer)) return;
    if (clock() >= offer.request.expiresAt) { close(offer, 'expired'); return; }
    let closure;
    try { closure = await sourceClosure(offer); } catch { return; }
    if (closure) close(offer, closure.state, closure);
  }

  function start(offer) {
    let run;
    try { run = runner.start(offer, settings()); }
    catch { saveState(offer, 'failed', { detail: 'Pi did not start. This approval is used. Inspect Herdr before asking again.' }); return; }
    saveState({ ...offer, run }, STARTED);
  }

  async function press(event) {
    const button = pressedButton(event.data?.custom_id);
    if (!button) return;
    const offer = store.get(button.launch);
    if (!offer || offer.state !== OFFERED || store.decision(button.launch)) return;
    const evidence = verifyPress(event, offer, settings(), clock(), button.action);
    if (button.action === BUTTON.refuse) { close(offer, 'refused', { evidence }); return; }
    let closure;
    try { closure = await sourceClosure(offer); }
    catch { await discord.tell(event, SOURCE_SILENT); return; }
    if (closure) { close(offer, closure.state, closure); return; }
    decide(offer, CLAIMED, verifyPress(event, offer, settings(), clock(), button.action));
    start(offer);
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

  async function advance(offer) {
    await refresh(offer);
    const latest = store.get(offer.request.launch);
    if (latest.state === STARTED) {
      const result = runner.result(latest.run);
      if (result) saveState(latest, result.status, result);
    }
    await deliver(store.get(offer.request.launch));
  }

  async function tick() {
    for (const offer of store.all()) {
      try { await advance(offer); }
      catch { warn('A launch refresh or delivery failed. It will retry.'); }
    }
  }
  return { notice, press, tick };
}
