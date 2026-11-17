import { WorkerRuntime } from './worker-runtime.mjs';

export default function workerAgent(pi) {
  const worker = { name: process.env.POTS_WORKER, owner: process.env.POTS_OWNER, launchId: process.env.POTS_LAUNCH };
  if (!worker.name || !worker.owner || !worker.launchId || !process.env.HC_TERMINAL_ID) return;
  let runtime;
  pi.on('session_start', (_event, context) => {
    if (context.mode !== 'tui') return;
    runtime = new WorkerRuntime(pi, worker);
    runtime.start(context);
  });
  pi.on('input', (event, context) => runtime?.input(event, context));
  pi.on('agent_start', (_event, context) => runtime?.invalidate(context));
  pi.on('agent_settled', (_event, context) => runtime?.settle(context));
  pi.on('session_shutdown', () => runtime?.stop());
}
