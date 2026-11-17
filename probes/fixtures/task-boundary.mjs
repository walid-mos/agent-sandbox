import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { mock } from 'node:test';

const home = process.env.POTS_TASK_FIXTURE;
if (!home) throw new Error('Synthetic fixture requires its owned temporary home.');
const boundaryFile = join(home, 'boundary.json');
const read = () => JSON.parse(readFileSync(boundaryFile, 'utf8'));
const persist = boundary => writeFileSync(boundaryFile, JSON.stringify(boundary));
const botHome = join(home, 'bot');
mock.module('node:os', { exports: { homedir: () => home, tmpdir: os.tmpdir, totalmem: os.totalmem } });
mock.module('../../session/sandbox.mjs', { exports: {
  botId: 'synthetic', botHome, potsHome: home, owners: ['example'], isMastermind: false,
  sandbox: { bot: 'synthetic', owners: { example: 'UNUSED' }, maxWorkers: 1 },
} });

function command(binary, args) {
  const boundary = read();
  boundary.calls.push({ binary, args });
  persist(boundary);
  if (binary === 'pots' && args[0] === 'wake') {
    const id = args[args.indexOf('--id') + 1];
    if (!boundary.wakes.some(wake => wake.id === id)) boundary.wakes.push({ id, note: JSON.parse(args.at(-1)) });
    const isUncertain = boundary.loseReply;
    boundary.loseReply = false;
    persist(boundary);
    if (isUncertain) throw new Error('Simulated lost bot transport reply.');
    return '';
  }
  if (binary === 'pots') return 'synthetic: Synthetic, router, idle, ready';
  if (binary === 'bash') return 'https://example.test/synthetic/pull/1';
  if (binary === 'git' && args[0] === 'worktree') mkdirSync(args.at(-2), { recursive: true });
  if (binary === 'git') return ({ branch: 'feat/synthetic', 'rev-parse': 'abcdef1', status: '', 'rev-list': '0' })[args[0]] ?? '';
  if (binary === 'pi') return '';
  if (binary === 'hc') return terminalCommand(args, boundary);
  throw new Error(`Unexpected synthetic boundary command ${binary}.`);
}

function terminalCommand(args, boundary) {
  if (args[0] === 'ls') return JSON.stringify({ terminals: boundary.terminals });
  if (args[0] === 'get') {
    const terminal = boundary.terminals.find(item => [item.address, item.name].includes(args.at(-1)));
    if (!terminal) throw new Error('Synthetic terminal is absent.');
    return JSON.stringify(terminal);
  }
  if (args[0] === 'read') return 'Synthetic final result.';
  if (args[0] === 'run') {
    if (boundary.failLaunch) throw new Error('Simulated worker launch failure.');
    const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
    boundary.terminals.push({ address: 't-synthetic-new', name: args[args.indexOf('--name') + 1],
      cwd: args[args.indexOf('--cwd') + 1], state: 'live', status: 'working', labels });
  } else if (args[0] === 'send') {
    if (boundary.loseSend) {
      boundary.loseSend = false;
      persist(boundary);
      throw new Error('Simulated uncertain terminal delivery.');
    }
  } else if (['kill', 'rm'].includes(args[0])) {
    boundary.terminals = boundary.terminals.filter(item => item.address !== args.at(-1));
  } else throw new Error(`Unexpected synthetic hc operation ${args[0]}.`);
  persist(boundary);
  return '';
}

mock.module('../../session/run.mjs', { exports: {
  WITH_VAULT: '/synthetic/unused-vault', command, commandOutput: async (...args) => command(...args),
  failureReason: error => error.message, commandWithInput: async (...args) => command(...args),
} });
