import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandOutput } from '../session/run.mjs';
import { parsedLine } from '../session/jsonl.mjs';
import { REPORT_CHARACTERS } from '../session/launch-contract.mjs';

const FINAL_STOP = 'stop';
const IDLE = ['idle', 'done'];
const LAST_ERROR_CHARACTERS = 300;
const STATUS_MS = 5000;

// Herdr answers a name it does not hold with a not_found error, which is a fact about the terminal. Any other failure says nothing about it.
async function terminalNamed(name) {
  try { return JSON.parse(await commandOutput('hc', ['get', '--json', name], { timeout: STATUS_MS, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (error) {
    if (/"kind":\s*"not_found"/.test(`${error.stderr ?? ''}`)) return undefined;
    throw new Error('mac-launch: Herdr did not answer for the launch terminal.');
  }
}

export function herdrRunner(store, program = [process.execPath, fileURLToPath(new URL('./launch-pi.mjs', import.meta.url))]) {
  async function start(offer, settings) {
    const { request } = offer;
    const name = `ml-${request.launch.slice(0, 24)}`;
    const session = store.session(request.launch);
    const arguments_ = ['run', '--bg', '--no-parent', '--no-notify', '--outlive-parent', '--json', '--name', name, '--cwd', settings.directory,
      '--label', `mac-launch.id=${request.launch}`, '--', ...program, store.folder, request.launch];
    try {
      await commandOutput('hc', arguments_, { timeout: 10_000 });
      const terminal = await terminalNamed(name);
      if (terminal?.labels?.['mac-launch.id'] !== request.launch) throw new Error('wrong terminal');
      return { name, session, createdMs: terminal.created_ms };
    } catch {
      throw new Error('mac-launch: Pi did not start in Herdr. Inspect the ml- terminal before making a new request.');
    }
  }
  async function result(run) {
    const terminal = await terminalNamed(run.name);
    const isGone = !terminal || terminal.created_ms !== run.createdMs;
    const hasStopped = isGone || IDLE.includes(terminal.status) || terminal.state === 'finished';
    // A running Pi's log is only read once its terminal stops, so a long session is not parsed on every poll.
    if (!hasStopped) return undefined;
    const ended = lastTurn(run.session);
    if (ended) return ended;
    if (isGone) return { status: 'failed', detail: 'The Herdr terminal is gone and Pi left no final reply.' };
    if (terminal.state === 'finished') return { status: 'failed', detail: 'Pi stopped without a final reply.' };
    return undefined;
  }
  return { start, result };
}

const textOf = message => (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, REPORT_CHARACTERS);

// A turn that ended on something else than a clean stop reports why, so a launch never waits for a reply that will not come.
function lastTurn(path) {
  if (!existsSync(path)) return undefined;
  const messages = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(parsedLine);
  const last = messages.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant')?.message;
  if (!last) return undefined;
  const text = textOf(last);
  if (last.stopReason === FINAL_STOP) return text ? { status: 'finished', report: text } : undefined;
  if (last.stopReason === undefined || last.stopReason === 'toolUse') return undefined;
  return { status: 'failed', detail: last.errorMessage?.slice(0, LAST_ERROR_CHARACTERS) || text.slice(0, LAST_ERROR_CHARACTERS) || `Pi ended its turn with ${last.stopReason}.` };
}
