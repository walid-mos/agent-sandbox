import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queued } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { allTerminals, WORKERS, workers } from './workers.mjs';
import { canFinish, hasUncollectedHelpers, lifecycleOf, lifecyclePath, resultId, writeLifecycle } from './worker-lifecycle.mjs';

export function keepResult(worker, terminal, state) {
  const id = resultId(state);
  if (worker.result?.id === id) return worker.result;
  const folder = join(WORKERS, 'results', worker.name, id);
  mkdirSync(folder, { recursive: true });
  const screen = join(folder, 'screen.txt');
  const transcript = join(folder, 'conversation.jsonl');
  copyFileSync(state.sessionFile, transcript);
  chmodSync(transcript, 0o600);
  const text = command('hc', ['read', '--lines', '0', terminal.address]);
  writeFileSync(screen, text, { mode: 0o600 });
  return { id, state, screen, transcript };
}

export function acknowledgeResult([name, id]) {
  const worker = workers().find(candidate => candidate.name === name && candidate.owner === botId);
  if (!worker?.result || worker.result.id !== id) throw new Error('dispatch: read the current saved result, then finish with its exact result ID.');
  const state = lifecycleOf(worker);
  const terminals = allTerminals();
  const terminal = terminals.find(candidate => candidate.address === worker.terminal);
  if (!state || !terminal || resultId(state) !== id || !canFinish(state, terminal, Date.now()) || hasUncollectedHelpers(terminal, terminals)) throw new Error('dispatch: the result changed or the worker still needs attention. Read its current report.');
  if (queued().some(request => request.worker === name)) throw new Error('dispatch: a follow-up is queued. Let the worker read it first.');
  writeLifecycle(lifecyclePath(worker, 'receipt'), { id, receivedBy: botId, receivedAt: Date.now() });
  process.stdout.write(`Acknowledged ${id}. Pots will close ${name} only while its session stays finished.\n`);
}
