import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PROVISIONING_FILE, provisioning } from './agent-sources.mjs';
import { main } from './main.mjs';

main(import.meta, () => {
  const [routerApi] = process.argv.slice(2);
  if (!routerApi) throw new Error('provision-runtime: expected the router API address, which session/bootstrap passes.');
  mkdirSync(dirname(PROVISIONING_FILE), { recursive: true });
  writeFileSync(PROVISIONING_FILE, JSON.stringify({
    ...provisioning,
    magpieBaseUrl: routerApi,
  }, null, 2) + '\n', { mode: 0o600 });
});
