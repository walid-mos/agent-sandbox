import { randomBytes } from 'node:crypto';
import { DISCORD_INTERVAL_MS } from './pr-board-contract.mjs';
import { boardSummary, renderBoard, renderEvent } from './pr-board-render.mjs';

async function message(key, content, context) {
  const { state, store, client, now } = context;
  const messages = state.discord.messages ??= {};
  const saved = messages[key] ??= { nonce: randomBytes(12).toString('hex') };
  if (saved.id && saved.content === content) return false;
  state.discord.attemptedAt = now;
  store.save(state);
  if (saved.id) await client.edit(saved.id, content);
  else saved.id = await client.create(content, saved.nonce);
  saved.content = content;
  store.save(state);
  return true;
}

async function pinIndex(context) {
  const { state, store, client, now } = context;
  if (state.discord.isPinned) return false;
  state.discord.attemptedAt = now;
  store.save(state);
  await client.pin(state.discord.messages.index.id);
  state.discord.isPinned = true;
  store.save(state);
  return true;
}

async function continuations(pages, context) {
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const next = context.state.discord.messages[`page-${index + 1}`];
    const navigation = index + 1 < pages.length ? `\nNext <${context.client.link(next.id)}>` : '';
    if (await message(`page-${index}`, `Board page ${index + 1}/${pages.length}\n${pages[index]}${navigation}`, context)) return true;
  }
  return false;
}

async function retirePages(count, context) {
  const keys = Object.keys(context.state.discord.messages).filter(key => key.startsWith('page-') && Number(key.slice(5)) >= count);
  for (const key of keys) {
    if (await message(key, 'This continuation is retired. Open the pinned pull request board.', context)) return true;
  }
  return false;
}

async function eventMessages(context, configuration) {
  const { state, store } = context;
  for (const [key, event] of Object.entries(state.events)) {
    if (event.posted || !configuration.sources[event.pot]?.includes(event.claim.repository)) continue;
    const didSend = await message(`event-${key}`, renderEvent(event), context);
    event.posted = true;
    store.save(state);
    if (didSend) return;
  }
}

export async function reconcileDiscord({ store, configuration, client, now }) {
  const state = store.read();
  if (now - (state.discord.attemptedAt ?? -Infinity) < DISCORD_INTERVAL_MS) return;
  const pages = renderBoard(state, configuration, now);
  const context = { state, store, client, now };
  const summary = boardSummary(state, configuration, now);
  if (!state.discord.messages?.index?.id && await message('index', pages.length === 1 ? pages[0] : `${summary}\nPreparing continuation messages.`, context)) return;
  if (await pinIndex(context)) return;
  if (pages.length > 1 && await continuations(pages, context)) return;
  if (await retirePages(pages.length > 1 ? pages.length : 0, context)) return;
  const content = pages.length === 1 ? pages[0] : `${summary}\n${pages.length} board pages · <${client.link(state.discord.messages['page-0'].id)}>`;
  if (await message('index', content, context)) return;
  await eventMessages(context, configuration);
}
