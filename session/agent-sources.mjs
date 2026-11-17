import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_FILE = fileURLToPath(new URL('./agent-sources.json', import.meta.url));
const REPOSITORY = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const CREDENTIAL = /^[A-Z][A-Z0-9_]*$/;

export const PROVISIONING_FILE = join(homedir(), '.config/agent-sandbox/provisioning.json');
export const provisioning = existsSync(PROVISIONING_FILE) ? JSON.parse(readFileSync(PROVISIONING_FILE, 'utf8')) : {};
const sandboxFile = '/etc/agent-sandbox/sandbox.json';
const sandbox = existsSync(sandboxFile) ? JSON.parse(readFileSync(sandboxFile, 'utf8')) : undefined;
export const effectiveProvisioning = {
  ...provisioning,
  herdr: {
    sandboxes: sandbox ? [{ machine: '', bot: sandbox.bot }] : [],
    controlPath: fileURLToPath(new URL('./control.mjs', import.meta.url)),
    ...provisioning.herdr,
  },
};
const sourceCatalog = JSON.parse(readFileSync(SOURCE_FILE, 'utf8'));

function selectedSources(config) {
  const names = config.sources;
  if (!Array.isArray(names) || !names.every(name => Object.hasOwn(sourceCatalog, name))) {
    throw new Error(`agent-sources: sandbox.json must select the sources this pot fetches, as a list of names from ${SOURCE_FILE}: ${Object.keys(sourceCatalog).join(', ')}. Fix it on the Mac and run bin/vm-config.`);
  }
  return names;
}

// The pot fetches only the sources its sandbox.json selects. A source with a credential in the catalog is private and fetched with that token from the VM's vault broker; any other is public and cloned anonymously.
const selected = new Set(sandbox ? selectedSources(sandbox) : []);
export const agentSources = Object.fromEntries(Object.entries(sourceCatalog).map(([name, source]) => [name, {
  ...source, ...provisioning.sources?.[name], directory: source.directory, credential: source.credential, selected: selected.has(name),
}]));
for (const [name, source] of Object.entries(agentSources)) {
  if (!REPOSITORY.test(source.repository) || (source.credential !== undefined && !CREDENTIAL.test(source.credential))
    || typeof source.directory !== 'string' || source.directory.startsWith('/') || source.directory.split('/').includes('..')) {
    throw new Error(`agent-sources: invalid ${name} in ${SOURCE_FILE}. Use owner/repository, a credential variable name for a private source only, and a home-relative directory.`);
  }
}

export const sourceFor = repository => Object.values(agentSources).find(source => source.repository === repository);
