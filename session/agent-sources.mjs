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
  nextnode: sandbox ? Object.hasOwn(sandbox.owners, 'NextNodeSolutions') : false,
  ...provisioning,
  herdr: {
    sandboxes: sandbox ? [{ machine: '', bot: sandbox.bot }] : [],
    controlPath: fileURLToPath(new URL('./control.mjs', import.meta.url)),
    ...provisioning.herdr,
  },
};
const sourceCatalog = JSON.parse(readFileSync(SOURCE_FILE, 'utf8'));
export const agentSources = Object.fromEntries(Object.entries(sourceCatalog).map(([name, source]) => [name, {
  ...source, ...provisioning.sources?.[name], directory: source.directory,
}]));
for (const [name, source] of Object.entries(agentSources)) {
  if (!REPOSITORY.test(source.repository) || !CREDENTIAL.test(source.credential)
    || typeof source.directory !== 'string' || source.directory.startsWith('/') || source.directory.split('/').includes('..')) {
    throw new Error(`agent-sources: invalid ${name} in ${SOURCE_FILE}. Use owner/repository, a credential variable name and a home-relative directory.`);
  }
}

export const sourceFor = repository => Object.values(agentSources).find(source => source.repository === repository);
