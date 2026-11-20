import { isDurableFactory } from './factory-mode-facts.mjs';
import { main } from './main.mjs';

export { isDurableFactory };

main(import.meta, () => {
  process.exitCode = isDurableFactory ? 0 : 1;
});
