import { localAddress, readConversation } from './adopted-execution.mjs';
import { SESSION_LABEL } from './worker-human.mjs';
import { isLive, terminalOf } from './workers.mjs';

function observeStandalone(terminal) {
  try {
    localAddress(terminal.address);
    const conversation = readConversation(terminal.labels?.[SESSION_LABEL]);
    return { terminal: terminal.address, name: terminal.name, parent: terminal.parent, createdAt: terminal.created_ms,
      sessionFile: conversation.path, sessionId: conversation.id, state: terminal.state, observedStatus: terminal.status,
      status: isLive(terminal) ? terminal.status : 'ended', finishedAt: terminal.finished_ms };
  } catch {
    return undefined;
  }
}

export function standaloneExecutions(records, terminals) {
  return terminals.filter(terminal => ['live', 'finished'].includes(terminal.state) &&
    !terminal.labels?.['pots.owner'] && !terminal.labels?.['pots.launch'] &&
    !records.some(worker => terminalOf(worker, [terminal])))
    .map(observeStandalone).filter(Boolean);
}
