import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { main } from './main.mjs';
import { commandOutput, failureReason } from './run.mjs';
import { sandbox } from './sandbox.mjs';

const SCHEMA = 1;
const DEFAULT_WINDOW_SECONDS = '10';
const OPTIONS = { seconds: { type: 'string', default: DEFAULT_WINDOW_SECONDS } };
const USAGE = 'usage: load.mjs [--seconds WINDOW]';
const PRESSURE_RESOURCES = ['cpu', 'io', 'memory'];
const MEMORY_FIELDS = { MemTotal: 'totalKiB', MemAvailable: 'availableKiB', SwapTotal: 'swapTotalKiB', SwapFree: 'swapFreeKiB' };
const SESSION_MEMORY = '/sys/fs/cgroup/memory.current';
const WORKER_LABEL = 'pots.worker=true';
const COMPOSE_PROJECT = 'com.docker.compose.project';
// /proc/stat counts user, nice, system, idle, iowait, irq, softirq and steal in this order; guest time is already inside user.
const CPU_FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];
const MICROSECONDS = 1e6;
const BYTES_PER_KIB = 1024;
const DECIMALS = 2;

const rounded = value => Number(value.toFixed(DECIMALS));
const percent = (part, whole) => (whole > 0 ? rounded((part / whole) * 100) : 0);

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function cpuTimes(stat) {
  const fields = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return Object.fromEntries(CPU_FIELDS.map((name, index) => [name, fields[index] ?? 0]));
}

export function cpuShares(before, after) {
  const spent = Object.fromEntries(CPU_FIELDS.map(name => [name, after[name] - before[name]]));
  const total = CPU_FIELDS.reduce((sum, name) => sum + spent[name], 0);
  return {
    busyPercent: percent(total - spent.idle - spent.iowait, total),
    iowaitPercent: percent(spent.iowait, total),
    stealPercent: percent(spent.steal, total),
  };
}

export function pressureLines(text) {
  return Object.fromEntries(text.trim().split('\n').map(line => {
    const [kind, ...pairs] = line.split(' ');
    return [kind, Object.fromEntries(pairs.map(pair => pair.split('=')).map(([name, value]) => [name, Number(value)]))];
  }));
}

// The kernel's averages decay over 10, 60 and 300 seconds; the stalled share of this exact window comes from the total it counts in microseconds.
export function pressureOver(before, after, windowSeconds) {
  return Object.fromEntries(Object.entries(after).map(([kind, { total, ...averages }]) => {
    const stalled = total - (before[kind]?.total ?? total);
    return [kind, { ...averages, windowPercent: percent(stalled, windowSeconds * MICROSECONDS) }];
  }));
}

function readPressure() {
  return Object.fromEntries(PRESSURE_RESOURCES.map(resource => {
    const text = readText(`/proc/pressure/${resource}`);
    return [resource, text && pressureLines(text)];
  }));
}

export function memoryFacts(meminfo, sessionBytes) {
  const amounts = Object.fromEntries(meminfo.split('\n').filter(Boolean).map(line => {
    const [name, amount] = line.split(':');
    return [name, Number.parseInt(amount, 10)];
  }));
  const facts = Object.fromEntries(Object.entries(MEMORY_FIELDS).map(([field, name]) => [name, amounts[field] ?? null]));
  return { ...facts, sessionKiB: sessionBytes === null ? null : Math.round(Number(sessionBytes) / BYTES_PER_KIB) };
}

const countByState = terminals => ({
  live: terminals.filter(terminal => terminal.state === 'live').length,
  finished: terminals.filter(terminal => terminal.state !== 'live').length,
});

async function terminalCounts() {
  const list = async labels => JSON.parse(await commandOutput('hc', ['ls', '--all', '--json', ...labels])).terminals;
  const [every, workers] = await Promise.all([list([]), list(['--label', WORKER_LABEL])]);
  const { live: workersLive, finished: workersFinished } = countByState(workers);
  return { ...countByState(every), workersLive, workersFinished };
}

export function containerCounts(rows) {
  const containers = rows.split('\n').filter(Boolean).map(row => row.split('\t'));
  const isRunning = ([state]) => state === 'running';
  const projects = [...new Set(containers.map(([, project]) => project).filter(Boolean))].sort();
  return {
    running: containers.filter(isRunning).length,
    total: containers.length,
    composeProjects: projects.map(name => {
      const own = containers.filter(([, project]) => project === name);
      return { name, running: own.filter(isRunning).length, total: own.length };
    }),
  };
}

async function dockerCounts() {
  return containerCounts(await commandOutput('docker', ['ps', '--all', '--format', `{{.State}}\t{{.Label "${COMPOSE_PROJECT}"}}`]));
}

// A tool that does not answer leaves its section null and names itself here, so one missing part never hides the others.
async function section(name, read, unavailable) {
  try {
    return await read();
  } catch (error) {
    unavailable.push(`${name}: ${failureReason(error) || (error instanceof Error ? error.message : 'did not answer')}`);
    return null;
  }
}

async function measure(windowSeconds) {
  const unavailable = [];
  const before = { cpu: cpuTimes(readFileSync('/proc/stat', 'utf8')), pressure: readPressure() };
  const [terminals, containers] = await Promise.all([
    section('terminals', terminalCounts, unavailable),
    section('containers', dockerCounts, unavailable),
    pause(windowSeconds * 1000),
  ]);
  const pressureNow = readPressure();
  const pressure = Object.fromEntries(PRESSURE_RESOURCES.map(resource => {
    if (!pressureNow[resource]) unavailable.push(`pressure.${resource}: /proc/pressure/${resource} is not readable here`);
    return [resource, pressureNow[resource] && pressureOver(before.pressure[resource] ?? {}, pressureNow[resource], windowSeconds)];
  }));
  return {
    schema: SCHEMA,
    bot: sandbox.bot,
    at: new Date().toISOString(),
    windowSeconds,
    cpu: { ...cpuShares(before.cpu, cpuTimes(readFileSync('/proc/stat', 'utf8'))), load1: rounded(loadavg()[0]) },
    pressure,
    memory: memoryFacts(readFileSync('/proc/meminfo', 'utf8'), readText(SESSION_MEMORY)),
    terminals,
    containers,
    unavailable,
  };
}

main(import.meta, async () => {
  const { values } = parseArgs({ options: OPTIONS });
  const windowSeconds = Number(values.seconds);
  if (!(windowSeconds > 0)) throw new Error(`${USAGE}. WINDOW is a number of seconds above 0, got ${values.seconds}.`);
  process.stdout.write(`${JSON.stringify(await measure(windowSeconds))}\n`);
});
