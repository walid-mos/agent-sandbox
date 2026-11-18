import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandOutput } from '../session/run.mjs';
import { parsedLine } from '../session/jsonl.mjs';
import { REPORT_CHARACTERS } from '../session/launch-contract.mjs';
import { CODE_HOME, gateEnvironment } from './launch-execution-contract.mjs';
import { runPaths } from './launch-isolation.mjs';
import { checkProtectedInstallation, readBounded } from './launch-protection.mjs';

const IDLE = ['idle', 'done'];
const LAST_ERROR_CHARACTERS = 300;
const STATUS_MS = 5000;

export function protectedHerdr(settings) {
  checkProtectedInstallation(settings);
  return { binary: settings.tools.hc, env: gateEnvironment(), directory: CODE_HOME,
    program: [settings.tools.node, join(CODE_HOME, 'mac/launch-pi.mjs')],
    session: id => runPaths(id).session, owner: settings.execution.uid };
}

export function herdrRunner(context) {
  const exec = (arguments_, timeout) => commandOutput(context.binary, arguments_, { timeout, env: context.env, stdio: ['ignore', 'pipe', 'pipe'] });
  async function terminalNamed(name) {
    try { return JSON.parse(await exec(['get', '--json', name], STATUS_MS)); }
    catch (error) {
      if (/"kind":\s*"not_found"/.test(`${error.stderr ?? ''}`)) return undefined;
      throw new Error('mac-launch: the protected Herdr did not answer for the launch terminal.');
    }
  }
  async function start(offer) {
    const { launch } = offer.request;
    const name = `ml-${launch.slice(0, 24)}`;
    const session = context.session(launch);
    const arguments_ = ['run', '--bg', '--no-parent', '--no-notify', '--outlive-parent', '--json', '--name', name, '--cwd', context.directory,
      '--label', `mac-launch.id=${launch}`, '--', ...context.program, launch];
    try {
      await exec(arguments_, 10_000);
      const terminal = await terminalNamed(name);
      if (terminal?.labels?.['mac-launch.id'] !== launch) throw new Error('wrong terminal');
      return { name, session, owner: context.owner, createdMs: terminal.created_ms };
    } catch {
      throw new Error('mac-launch: Pi did not start in protected Herdr. Inspect the ml- terminal before making a new request.');
    }
  }
  async function result(run) {
    const terminal = await terminalNamed(run.name);
    const isGone = !terminal || terminal.created_ms !== run.createdMs;
    const hasStopped = isGone || IDLE.includes(terminal.status) || terminal.state === 'finished';
    if (!hasStopped) return undefined;
    let ended;
    try { ended = lastTurn(run.session, run.owner); }
    catch { return { status: 'failed', detail: 'Pi left an unsafe, unreadable or oversized session report.' }; }
    if (ended) return ended;
    if (isGone) return { status: 'failed', detail: 'The Herdr terminal is gone and Pi left no final reply.' };
    if (terminal.state === 'finished') return { status: 'failed', detail: 'Pi stopped without a final reply.' };
    return undefined;
  }
  return { start, result };
}

const textOf = message => (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, REPORT_CHARACTERS);

function lastTurn(path, owner) {
  if (!existsSync(path)) return undefined;
  const messages = readBounded(path, owner).split('\n').filter(Boolean).flatMap(parsedLine);
  const last = messages.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant')?.message;
  if (!last) return undefined;
  const text = textOf(last);
  if (last.stopReason === 'stop') return text ? { status: 'finished', report: text } : { status: 'failed', detail: 'Pi ended its turn without a final text reply.' };
  if (last.stopReason === undefined || last.stopReason === 'toolUse') return undefined;
  return { status: 'failed', detail: last.errorMessage?.slice(0, LAST_ERROR_CHARACTERS) || text.slice(0, LAST_ERROR_CHARACTERS) || `Pi ended its turn with ${last.stopReason}.` };
}
