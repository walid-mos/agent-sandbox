import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasQueued } from './queue.mjs';
import { command } from './run.mjs';
import { botId } from './sandbox.mjs';
import { allTerminals, ownedWorker, WORKERS } from './workers.mjs';
import { canFinish, isHibernated, lifecycleOf, receiptPath, resultId } from './worker-lifecycle.mjs';
import { writePrivateJson } from './private-json.mjs';

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

function workerForResult(name, id) {
  const worker = ownedWorker(name, botId);
  const result = worker?.result;
  if (!result || result.id !== id) throw new Error('dispatch: read the current saved result, then finish with its exact result ID.');
  return worker;
}

function verifyCurrentResult(worker, id) {
  const state = lifecycleOf(worker);
  const terminals = allTerminals();
  const terminal = terminals.find(candidate => candidate.address === worker.terminal);
  if (!state) throw new Error('dispatch: the result is no longer live. Read its current report.');
  if (terminal) {
    const isCurrent = [resultId(state) === id, canFinish(state, terminal, terminals, Date.now())].every(Boolean);
    if (!isCurrent) throw new Error('dispatch: the result changed or the worker still needs attention. Read its current report.');
    return;
  }
  // A saved result stays collectable after the worker's own close: the settled state that recorded it is still on file.
  const isSameSettlement = isHibernated(state) && worker.result.state.settledAt === state.settledAt;
  if (!isSameSettlement) throw new Error('dispatch: the result is no longer live. Read its current report.');
}

export function acknowledgeResult([name, id]) {
  const worker = workerForResult(name, id);
  verifyCurrentResult(worker, id);
  if (hasQueued(name)) throw new Error('dispatch: a follow-up is queued. Let the worker read it first.');
  writePrivateJson(receiptPath(worker), { id, receivedBy: botId, receivedAt: Date.now() });
  process.stdout.write(`Acknowledged ${id}. Pots will close ${name} only while its session stays finished.\n`);
}
