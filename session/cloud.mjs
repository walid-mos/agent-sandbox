import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentSources } from './agent-sources.mjs';
import { potsIndex } from './cloud-index.mjs';
import { main } from './main.mjs';
import { isMastermind, sandbox } from './sandbox.mjs';

const TAILNET_LINK = join(homedir(), agentSources.pi.directory, 'bin/tailnet-link');
// Every pot serves this folder under its own tailnet name, so the links page sits among the Mastermind's own files.
const INDEX_FOLDER = join(homedir(), 'Public/deliverables/pots');
const INDEX_FILE = join(INDEX_FOLDER, 'index.html');
const JOIN_KEY = 'TS_AUTHKEY';
const MASTERMIND_OWNS = 'The Mastermind, the person\'s entry point';

// The pot joins its own tailnet node, so tailnet-link never holds a key that would make it join on its own.
function tailnetLink(arguments_) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== JOIN_KEY));
  return execFileSync(TAILNET_LINK, arguments_, { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

// A pot's session node carries the pot's name, so a neighbour's root differs from this one by its first label only.
function potRoot(root, pot) {
  const url = new URL(root);
  url.hostname = [pot, ...url.hostname.split('.').slice(1)].join('.');
  return url.href;
}

function writeIndex(root) {
  const [own] = new URL(root).hostname.split('.');
  const neighbours = Object.entries(sandbox.doors ?? {}).map(([name, owns]) => ({ name, owns, url: potRoot(root, name) }));
  const page = potsIndex([{ name: own, owns: MASTERMIND_OWNS, url: root }, ...neighbours]);
  if (existsSync(INDEX_FILE) && readFileSync(INDEX_FILE, 'utf8') === page) return;
  mkdirSync(INDEX_FOLDER, { recursive: true });
  writeFileSync(INDEX_FILE, page);
}

main(import.meta, () => {
  const root = tailnetLink(['setup']);
  process.stdout.write(`cloud: ${sandbox.bot} serves its files at ${root}\n`);
  if (!isMastermind) return;
  writeIndex(root);
  process.stdout.write(`cloud: every pot's links are at ${tailnetLink([INDEX_FOLDER])}\n`);
});
