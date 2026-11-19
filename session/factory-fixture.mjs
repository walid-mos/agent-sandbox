import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, join } from 'node:path';

const root = process.env.FACTORY_FIXTURE;
const repository = 'walid-mos/agent-sandbox';
const file = name => join(root, name);
const read = name => JSON.parse(readFileSync(file(name), 'utf8'));
function write(name, value) {
  const staging = file(`${name}.${process.pid}`);
  writeFileSync(staging, JSON.stringify(value));
  renameSync(staging, file(name));
}
const json = value => process.stdout.write(JSON.stringify(value));
const containerId = 'c'.repeat(64);

function github(args) {
  appendFileSync(file('calls'), `${args[0]} ${args[1]}\n`);
  const facts = read('facts');
  if (args[0] === 'repo') return json([{ nameWithOwner: repository, repositoryTopics: [{ name: 'factory' }] }]);
  if (args[1] === 'list') return json([{ number: facts.number, isDraft: facts.isDraft }]);
  if (args[1] === 'view') return json(facts);
  if (args[1] === 'merge' || args[1] === 'comment') throw new Error('unexpected write');
  if (args[1] !== 'graphql') return json(['factory']);
  if (args.includes('--paginate')) return json([{ data: { repository: { pullRequests: { nodes: [] } } } }]);
  return json({ data: { repository: { nameWithOwner: repository, isArchived: false, pullRequest: facts } } });
}

function waitForRelease(container) {
  return new Promise(resolve => {
    const watcher = watch(root, (_, name) => {
      if (name === 'release' || (name === 'container' && !existsSync(file('container')))) {
        watcher.close();
        resolve();
      }
    });
    write('blocked', { pid: process.pid, job: container.job });
  });
}

async function docker([operation, ...flags]) {
  const container = existsSync(file('container')) ? read('container') : undefined;
  if (operation === 'image') return;
  if (operation === 'create') {
    write('container', { name: flags[1], job: flags[3].split('=')[1], state: 'created' });
    process.stdout.write(containerId);
    return;
  }
  if (operation === 'ps') return process.stdout.write(container ? containerId : '');
  if (!container || flags.at(-1) !== containerId) throw new Error('unexpected container identity');
  if (operation === 'inspect') {
    const detail = flags.at(-2).includes('State') ? `${container.state} 0` : `/${container.name} ${container.job}`;
    return process.stdout.write(detail);
  }
  if (operation === 'rm') {
    if (container.name.endsWith('-check') && existsSync(file('refuse-cleanup'))) process.exit(1);
    appendFileSync(file('removed'), `${container.name} ${containerId}\n`);
    rmSync(file('container'));
    return;
  }
  if (operation !== 'start') throw new Error('unexpected Docker operation');
  write('container', { ...container, state: 'running' });
  if (container.name.endsWith('-check') && existsSync(file('gate'))) await waitForRelease(container);
  if (container.name.endsWith('-check') && existsSync(file('late'))) write('elapsed', 61 * 60_000);
  if (container.name.endsWith('-check') && existsSync(file('release'))) write('elapsed', 35 * 60_000);
  if (existsSync(file('container')) && read('container').name === container.name) write('container', { ...container, state: 'exited' });
}

export function launchController(directory, program, env, wakeSocket) {
  const stdio = ['ignore', 'ignore', 'inherit'];
  if (!process.env.FACTORY_TEST_S6) {
    const child = spawn(process.execPath, wakeSocket ? [program, wakeSocket] : [program], { env, stdio });
    return { child, stop: () => child.kill('SIGKILL') };
  }
  const service = join(directory, 'service');
  mkdirSync(service, { recursive: true });
  writeFileSync(join(service, 'run'), '#!/bin/sh\nexec "$FACTORY_NODE" "$FACTORY_PROGRAM" ${FACTORY_WAKE:+"$FACTORY_WAKE"}\n', { mode: 0o700 });
  const child = spawn('s6-supervise', [service], { env: { ...env, FACTORY_NODE: process.execPath, FACTORY_PROGRAM: program, FACTORY_WAKE: wakeSocket ?? '' }, stdio });
  return { child, stop: () => execFileSync('s6-svc', ['-dx', service]) };
}

function preload() {
  registerHooks({ load(url, context, next) {
    if (url.endsWith('/sandbox.mjs')) {
      return { format: 'module', shortCircuit: true, source: `export const owners = ['walid-mos'], sandbox = {}, botId = 'principal';` };
    }
    if (url.endsWith('/vault.mjs')) {
      return { format: 'module', shortCircuit: true, source: `process.execve(process.argv[2], process.argv.slice(2), process.env);` };
    }
    return next(url, context);
  } });
  if (process.argv[2] === 'run-job') {
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { value: () => now() + (existsSync(file('elapsed')) ? read('elapsed') : 0) });
  }
  if (basename(process.argv[1] ?? '') !== 'factory-controller.mjs') return;
  const interval = globalThis.setInterval;
  globalThis.setInterval = (handler, milliseconds, ...args) => {
    appendFileSync(file('intervals'), `${milliseconds}\n`);
    return interval(handler, milliseconds, ...args);
  };
}

if (root && !import.meta.main) preload();
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'gh') github(args);
  if (command === 'docker') await docker(args);
  if (command === 'pots') {
    const prior = existsSync(file('wakes')) ? readFileSync(file('wakes'), 'utf8') : '';
    writeFileSync(file('wakes.staging'), `${prior}${args.at(-1)}\n`);
    renameSync(file('wakes.staging'), file('wakes'));
  }
}
