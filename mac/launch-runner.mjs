import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../session/run.mjs';
import { REPORT_CHARACTERS } from '../session/launch-contract.mjs';

const FINAL_STOPS = ['stop', 'endTurn'];
const IDLE = ['idle', 'done'];
const LAST_ERROR_CHARACTERS = 300;

export function herdrRunner(folder, program = [process.execPath, fileURLToPath(new URL('./launch-pi.mjs', import.meta.url))]) {
  function start(offer, settings) {
    const { request } = offer;
    const name = `ml-${request.launch.slice(0, 24)}`;
    const session = join(folder, `${request.launch}.session.jsonl`);
    const arguments_ = ['run', '--bg', '--no-parent', '--no-notify', '--outlive-parent', '--json', '--name', name, '--cwd', settings.directory,
      '--label', `mac-launch.id=${request.launch}`, '--', ...program, request.launch];
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
    const terminal = JSON.parse(command('hc', ['get', '--json', run.name], { timeout: 5000 }));
    if (terminal.created_ms !== run.createdMs) return { status: 'failed', detail: 'The Herdr terminal was replaced.' };
    const reply = finalReply(run.session);
    if (reply && (IDLE.includes(terminal.status) || terminal.state === 'finished')) return { status: 'finished', report: reply };
    if (terminal.state === 'finished') return { status: 'failed', detail: 'Pi stopped without a final reply.' };
    return undefined;
  }
  return { start, result };
}

export function finalReply(path) {
  if (!existsSync(path)) return undefined;
  const messages = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const last = messages.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant')?.message;
  if (!last || !FINAL_STOPS.includes(last.stopReason)) return undefined;
  const reply = last.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  return reply.slice(0, REPORT_CHARACTERS) || last.errorMessage?.slice(0, LAST_ERROR_CHARACTERS);
}
