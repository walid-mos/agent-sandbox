import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { assignments, basicEnvironment, SESSION_VAULT_SETTINGS } from './environment.mjs';
import { main } from './main.mjs';

const SOCKET = assignments(readFileSync(new URL('./launch.env', import.meta.url), 'utf8')).POTS_VAULT_SOCKET;
const ANSWER_TIMEOUT_MS = 120_000;
const USAGE = 'usage: with-vault [--with GROUP | --source REPOSITORY] command [argument...] | with-vault --ready';

const REQUESTS = {
  '--with': group => ({ request: { kind: 'sandbox', group }, environment: process.env }),
  '--source': repository => ({ request: { kind: 'source', repository }, environment: basicEnvironment(process.env, SESSION_VAULT_SETTINGS) }),
};

// A parse error quotes its input, which holds secret values, so a fixed message replaces it.
function parsedAnswer(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('with-vault: the VM\'s vault broker sent an unreadable answer.');
  }
}

function checkedAnswer(text) {
  const answer = parsedAnswer(text);
  if (answer?.ok === true) return answer;
  throw new Error(`with-vault: the VM's vault broker refused: ${typeof answer?.error === 'string' ? answer.error : 'no reason given.'}`);
}

export function askVault(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const connection = createConnection(SOCKET);
    connection.setTimeout(ANSWER_TIMEOUT_MS, () => connection.destroy(new Error('no answer in time')));
    connection.on('connect', () => connection.end(`${JSON.stringify(request)}\n`));
    connection.on('data', chunk => chunks.push(chunk));
    connection.on('error', error => reject(new Error(`with-vault: the VM's vault broker at ${SOCKET} did not answer (${error.code ?? error.message}). Check pots-vault.service in the VM.`)));
    connection.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  }).then(checkedAnswer);
}

function secretPairs({ secrets }) {
  const isPair = pair => Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string');
  if (!Array.isArray(secrets) || !secrets.every(isPair)) throw new Error('with-vault: the VM\'s vault broker sent no secret list.');
  return secrets;
}

export async function readSecret(path, name) {
  const pairs = secretPairs(await askVault({ kind: 'secret', path, name }));
  if (pairs.length !== 1 || pairs[0][0] !== name) throw new Error('with-vault: the VM\'s vault broker answered with another secret name.');
  return pairs[0][1];
}

async function requireReady() {
  if (!SESSION_VAULT_SETTINGS.every(name => process.env[name])) {
    throw new Error('with-vault: the session holds no machine login. Run bin/session-bootstrap for this pot.');
  }
  const { ready } = await askVault({ kind: 'ready' });
  if (ready !== true) throw new Error('with-vault: the VM holds no vault identity yet. Run bin/session-bootstrap for this pot.');
}

function parsedArguments([flag, value, ...rest]) {
  if (!Object.hasOwn(REQUESTS, flag ?? '')) {
    return { request: { kind: 'sandbox' }, environment: process.env, commandLine: [flag, value, ...rest].filter(word => word !== undefined) };
  }
  if (!value) throw new Error(USAGE);
  return { ...REQUESTS[flag](value), commandLine: rest };
}

main(import.meta, async () => {
  if (process.argv[2] === '--ready') return requireReady();
  const { request, environment, commandLine } = parsedArguments(process.argv.slice(2));
  if (commandLine.length === 0) throw new Error(USAGE);
  const secrets = secretPairs(await askVault(request));
  process.execve('/usr/bin/env', ['env', ...commandLine], { ...environment, ...Object.fromEntries(secrets) });
});
