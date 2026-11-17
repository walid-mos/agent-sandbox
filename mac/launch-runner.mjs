import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { command } from '../session/run.mjs';
import { REPORT_CHARACTERS } from '../session/launch-contract.mjs';

const FINAL_STOP = 'stop';
const IDLE = ['idle', 'done'];
const LAST_ERROR_CHARACTERS = 300;
const STATUS_MS = 5000;

// Herdr answers a name it does not hold with a not_found error, which is a fact about the terminal. Any other failure says nothing about it.
function terminalNamed(name) {
  try { return JSON.parse(command('hc', ['get', '--json', name], { timeout: STATUS_MS, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (error) {
    if (/"kind":\s*"not_found"/.test(`${error.stderr ?? ''}`)) return undefined;
    throw new Error('mac-launch: Herdr did not answer for the launch terminal.');
  }
}

export function herdrRunner(store, program = [process.execPath, fileURLToPath(new URL('./launch-pi.mjs', import.meta.url))]) {
  function start(offer, settings) {
    const { request } = offer;
    const name = `ml-${request.launch.slice(0, 24)}`;
    const session = store.session(request.launch);
    const arguments_ = ['run', '--bg', '--no-parent', '--no-notify', '--outlive-parent', '--json', '--name', name, '--cwd', settings.directory,
      '--label', `mac-launch.id=${request.launch}`, '--', ...program, store.folder, request.launch];
    try {
      command('hc', arguments_, { timeout: 10_000 });
      const terminal = JSON.parse(command('hc', ['get', '--json', name]));
      if (terminal.labels?.['mac-launch.id'] !== request.launch) throw new Error('wrong terminal');
      return { name, session, createdMs: terminal.created_ms };
    } catch {
      throw new Error('mac-launch: Pi did not start in Herdr. Inspect the ml- terminal before making a new request.');
    }
  }
  function result(run) {
    const terminal = terminalNamed(run.name);
    const reply = finalReply(run.session);
    const isGone = !terminal || terminal.created_ms !== run.createdMs;
    if (reply && (isGone || IDLE.includes(terminal.status) || terminal.state === 'finished')) return { status: 'finished', report: reply };
    if (isGone) return { status: 'failed', detail: 'The Herdr terminal is gone and Pi left no final reply.' };
    if (terminal.state === 'finished') return { status: 'failed', detail: 'Pi stopped without a final reply.' };
    return undefined;
  }
  return { start, result };
}

function finalReply(path) {
  if (!existsSync(path)) return undefined;
  const messages = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const last = messages.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant')?.message;
  if (!last || last.stopReason !== FINAL_STOP) return undefined;
  const reply = last.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  return reply.slice(0, REPORT_CHARACTERS) || last.errorMessage?.slice(0, LAST_ERROR_CHARACTERS);
}
