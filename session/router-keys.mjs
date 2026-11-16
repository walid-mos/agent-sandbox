import { spawnSync } from 'node:child_process';
import { main } from './main.mjs';
import { sandbox } from './sandbox.mjs';

const VAULT_NAMES = { inco: 'INCO_API_KEY', openrouter: 'OPENROUTER_API_KEY', typesafe: 'TYPESAFE_API_KEY' };
const listed = new Set(Object.values(sandbox.secrets).flat());

// magpie reads a provider key from its arguments only, so the key shows in the session's process list while this runs.
function giveKey(provider, name) {
  const key = process.env[name];
  if (!key) throw new Error(`router-keys: ${name} is not in the environment. Run this through with-vault.`);
  const { status } = spawnSync('magpie', ['provider', 'key', provider, key], { stdio: 'ignore' });
  if (status !== 0) throw new Error(`router-keys: magpie refused the key of ${provider} (exit ${status}). Seed the router first.`);
}

main(import.meta, () => {
  const given = Object.entries(VAULT_NAMES).filter(([, name]) => listed.has(name));
  for (const [provider, name] of given) giveKey(provider, name);
  process.stdout.write(`router-keys: ${given.map(([provider]) => provider).join(', ')} hold their key\n`);
});
