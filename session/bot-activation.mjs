import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_ACTIVATION_ACTION } from './bot-activation-registry.mjs';
import { DIALOG_ID, MASTERMIND_POT } from './human-contract.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export const activationStateId = bot => digest(`${BOT_ACTIVATION_ACTION}:${bot.id}`).slice(0, 32);
export const activationStore = () => humanStore(join(HUMAN_HOME, 'bot-activation-state'));
export const canActivateBot = (configuration, bot) =>
  configuration.role === MASTERMIND_POT && Object.hasOwn(configuration.botActivation ?? {}, bot.id) && configuration.botActivation[bot.id] === true;
export const instructionPath = (bot, file) => fileURLToPath(new URL(`${bot.id}/${file}`, import.meta.url));

function scopeOf(bot, configuration, installArguments) {
  return {
    action: BOT_ACTIVATION_ACTION, bot: bot.id, handler: bot.handler,
    session: { bot: configuration.bot, host: hostname() }, install: installArguments(bot),
    instructions: Object.fromEntries(bot.files.map(file => [file, digest(readFileSync(instructionPath(bot, file)))])),
  };
}

function activeStatus(current) {
  if (!current) return { status: 'awaiting_activation' };
  return { status: current.isInstalled ? 'already_active' : 'installation_pending', approval: current.approval };
}

export function botActivation(bot, { configuration, approvals, state, install, installArguments }) {
  const id = activationStateId(bot);
  const scope = () => scopeOf(bot, configuration, installArguments);
  const status = () => activeStatus(state.get(id));
  const prepare = () => {
    const current = state.get(id);
    return current ? activeStatus(current) : approvals.prepare(scope());
  };
  const register = input => approvals.register(scope(), input);
  const apply = approval => {
    if (typeof approval !== 'string' || !DIALOG_ID.test(approval)) throw new Error('bot-activate: apply needs the registered activation dialog ID.');
    return state.locked(async ({ get, save, lockDescriptor }) => {
      const current = get(id);
      if (current && current.approval !== approval) throw new Error('bot-activate: use the same approval that started this activation.');
      if (current?.isInstalled) return activeStatus(current);
      const approvedScope = scope();
      const { decision, authority } = await approvals.apply(approvedScope, approval);
      if (decision.status !== 'authorized') return decision;
      const installation = { id, approval, scope: approvedScope, authority };
      save({ ...installation, isInstalled: false });
      await install(bot, lockDescriptor);
      save({ ...installation, isInstalled: true });
      return { status: 'activated', approval };
    }, id);
  };
  return { status, prepare, register, apply };
}
