import { humanStore } from './human-store.mjs';
import { command } from './run.mjs';

export function publishedDialog(terminal, session, call) {
  return humanStore().all().find(dialog => dialog.source.type === 'worker' && dialog.source.worker === terminal.name && dialog.source.session === session && dialog.source.call === call);
}

const readTerminal = terminal => JSON.parse(command('hc', ['get', terminal.address]));

export function waitsForHuman(worker, terminal, { store = humanStore(), inspect = readTerminal } = {}) {
  const pending = store.all().filter(dialog => !dialog.result && dialog.source.type === 'worker' && dialog.source.worker === worker.name);
  if (!pending.length || !terminal.address) return false;
  const current = inspect(terminal);
  return pending.some(dialog => dialog.source.session === current.labels?.['pi.session']);
}
