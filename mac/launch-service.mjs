import { discordMessageUrl } from '../session/human-contract.mjs';
import { EXPIRED, LAUNCH_TTL_MS, launchStatus, noticeOf, OFFERED, OPEN, STARTED } from '../session/launch-contract.mjs';
import { boundRequest, BUTTON, CLAIMED, pressedButton, verifyOffer, verifyPress } from './launch-approval.mjs';
import { closedMessage, offerMessage } from './launch-messages.mjs';

const LIVE = [OFFERED, STARTED];
const SOURCE_CLOSURES = ['cancelled', 'superseded', EXPIRED];
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
    decide(offer, state, { ...evidence, ...details });
    return saveState(offer, state, details);
  }

  // A gate that stopped between its decision and its record finishes the record from the decision. A claim it cannot account for never launches again.
  function recover(offer) {
    const decided = store.decision(offer.request.launch);
    if (!decided) return false;
    if (decided.state === CLAIMED) saveState(offer, 'failed', { detail: UNACCOUNTED_CLAIM });
    else saveState(offer, decided.state, { detail: decided.detail });
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
  function closeUnoffered(shown, proposed, closure) {
    const { request, state } = boundRequest(shown, proposed, settings());
    // Keep a recoverable record before the decision even when Discord never showed an offer.
    const offer = store.save({ request, state: OFFERED, pending: [] });
    close(offer, closure?.state ?? state, closure);
  }

  async function notice(message, applicationId) {
    const config = settings();
    if (message.guild_id !== config.guildId || message.channel_id !== config.channelId
      || !config.announcers.includes(message.author?.id)) return;
    let proposed;
    try { proposed = noticeOf(message.content); } catch { return; }
    if (proposed.target !== config.name || !config.pots.includes(proposed.pot)) return;
    store.remember(proposed.launch, { message, applicationId, expiresAt: clock() + LAUNCH_TTL_MS });
    await offerNotice(message, applicationId, proposed, config);
    store.forget(proposed.launch);
  }

  async function refreshKnownNotice(proposed) {
    const known = store.get(proposed.launch);
    if (known) { await refresh(known); return true; }
    return Boolean(store.decision(proposed.launch));
  }

  function boundNotice(shown, proposed, config) {
    try { return boundRequest(shown, proposed, config); }
    catch { return undefined; }
  }

  function refuseInvalidNotice(shown, proposed, config, error) {
    const bound = boundNotice(shown, proposed, config);
    if (!bound) return;
    const state = clock() >= bound.request.expiresAt ? EXPIRED : 'refused';
    closeUnoffered(shown, proposed, { state, details: { detail: error.message } });
  }

  function verifiedNotice(shown, proposed, config) {
    try { return verifyOffer(shown, proposed, config, clock()); }
    catch (error) { refuseInvalidNotice(shown, proposed, config, error); return undefined; }
  }

  async function postOffer(message, applicationId, config, verified) {
    const messageUrl = discordMessageUrl({ guildId: message.guild_id, channelId: message.channel_id, messageId: message.id });
    const payload = offerMessage(verified, config, messageUrl);
    const posted = await discord.post(config.channelId, payload, verified.prompt);
    const offer = { ...verified, content: payload.content, guildId: config.guildId, channelId: config.channelId, applicationId,
      messageId: posted.id, attachment: posted.attachments[0], state: OFFERED, pending: [] };
    saveState(offer, OFFERED);
  }

  async function offerNotice(message, applicationId, proposed, config) {
    if (await refreshKnownNotice(proposed)) return;
    const shown = await pots.show(proposed.pot, proposed.launch);
    if (!boundNotice(shown, proposed, config)) return;
    if (SOURCE_CLOSURES.includes(shown.state)) return closeUnoffered(shown, proposed);
    const verified = verifiedNotice(shown, proposed, config);
    if (!verified) return;
    await postOffer(message, applicationId, config, verified);
  }

  async function refresh(offer) {
    if (offer.state !== OFFERED || recover(offer)) return;
    if (clock() >= offer.request.expiresAt) { close(offer, EXPIRED); return; }
    let closure;
    try { closure = await sourceClosure(offer); } catch { return; }
    if (closure) close(offer, closure.state, closure);
  }

  async function start(offer) {
    let run;
    try { run = await runner.start(offer, settings()); }
    catch { saveState(offer, 'failed', { detail: 'Pi did not start. This approval is used. Inspect Herdr before asking again.' }); return; }
    saveState({ ...offer, run }, STARTED);
  }

  async function checkedPress(event, offer, action) {
    try { return verifyPress(event, offer, settings(), clock(), action); }
    catch (error) { await discord.tell(event, error.message); return undefined; }
  }

  async function sourceAllowsStart(event, offer) {
    let closure;
    try { closure = await sourceClosure(offer); }
    catch { await discord.tell(event, SOURCE_SILENT); return false; }
    if (!closure) return true;
    close(offer, closure.state, closure);
    return false;
  }

  async function claimAndStart(event, offer, action) {
    const claim = await checkedPress(event, offer, action);
    if (!claim) return;
    decide(offer, CLAIMED, claim);
    await start(offer);
  }

  async function press(event) {
    const button = pressedButton(event.data?.custom_id);
    if (!button) return;
    const offer = store.get(button.launch);
    if (!offer || offer.state !== OFFERED || store.decision(button.launch)) return;
    const evidence = await checkedPress(event, offer, button.action);
    if (!evidence) return;
    if (button.action === BUTTON.refuse) { close(offer, 'refused', { evidence }); return; }
    if (!await sourceAllowsStart(event, offer)) return;
    await claimAndStart(event, offer, button.action);
  }

  async function deliver(offer) {
    while (offer.pending.length) {
      await pots.report(offer.request.pot, offer.pending[0]);
      offer = store.save({ ...offer, pending: offer.pending.slice(1) });
    }
    if (offer.needsEdit) {
      await discord.edit(offer.channelId, offer.messageId, closedMessage(offer));
      offer = store.save({ ...offer, needsEdit: false });
    }
    if (!LIVE.includes(offer.state)) store.shelve(offer.request.launch);
  }

  async function advance(offer) {
    await refresh(offer);
    const latest = store.get(offer.request.launch);
    if (latest.state === STARTED) {
      const result = await runner.result(latest.run);
      if (result) saveState(latest, result.status, result);
    }
    await deliver(store.get(offer.request.launch));
  }

  async function tick() {
    for (const pending of store.notices(id => warn(`mac-launch: notice ${id} could not be read.`))) {
      if (clock() >= pending.expiresAt) { store.forget(noticeOf(pending.message.content).launch); continue; }
      try { await notice(pending.message, pending.applicationId); }
      catch { warn('mac-launch: a notice could not be offered. It will retry.'); }
    }
    let offers;
    try { offers = store.all(id => warn(`mac-launch: launch ${id} could not be read. Inspect its record.`)); }
    catch { warn('mac-launch: the records directory could not be read. No pass ran.'); return; }
    for (const offer of offers) {
      try { await advance(offer); }
      catch { warn('A launch refresh or delivery failed. It will retry.'); }
    }
  }
  return { notice, press, tick };
}
