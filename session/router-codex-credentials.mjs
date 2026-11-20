import { main } from './main.mjs';
import { readLocalCredentialBytes } from './router-configuration.mjs';

main(import.meta, () => {
  readLocalCredentialBytes();
  process.stdout.write('CODEX_TARGETED_V1: local credential scope is readable. Values remain private.\n');
});
