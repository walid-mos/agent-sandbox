import { dialogId } from './human-dialogs.mjs';
import { humanStore } from './human-store.mjs';
import { command } from './run.mjs';

export function publishedDialog(terminal, session, call) {
  return humanStore().get(dialogId({ type: 'worker', worker: terminal.name, session, call }));
}

// The Pi harness publishes the interactive session's file under this terminal label.
export const SESSION_LABEL = 'pi.session';
export const readTerminal = terminal => JSON.parse(command('hc', ['get', terminal.address]));

export function waitsForHuman(worker, terminal, { store = humanStore(), inspect = readTerminal, sessionFile } = {}) {
  const pending = store.all().filter(dialog => !dialog.result && dialog.source.type === 'worker' && dialog.source.worker === worker.name);
  if (!pending.length || !terminal.address) return false;
  const current = sessionFile ?? inspect(terminal).labels?.[SESSION_LABEL];
  return pending.some(dialog => dialog.source.session === current);
}
