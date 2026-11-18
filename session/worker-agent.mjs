import { WorkerRuntime } from './worker-runtime.mjs';
import { launchedWorker, ownedWorker } from './workers.mjs';

export default function workerAgent(pi) {
  const worker = launchedWorker(process.env);
  if (![worker.name, worker.owner, worker.launchId, process.env.HC_TERMINAL_ID].every(Boolean)) return;
  let runtime;
  pi.on('session_start', (_event, context) => {
    if (context.mode !== 'tui') return;
    const record = ownedWorker(worker.name, worker.owner);
    if (record?.launchId !== worker.launchId) {
      context.ui.notify('pots lifecycle: this launch has no matching worker record. Resume it through the owning bot.', 'error');
      context.shutdown();
      return;
    }
    const { kind, resultFile, publication } = record;
    runtime = new WorkerRuntime(pi, { ...worker, kind, resultFile, publication });
    runtime.start(context);
  });
  pi.on('input', (event, context) => runtime?.input(event, context));
  pi.on('agent_start', (_event, context) => runtime?.invalidate(context));
  pi.on('agent_settled', (_event, context) => runtime?.settle(context));
  pi.on('session_shutdown', () => runtime?.stop());
}
