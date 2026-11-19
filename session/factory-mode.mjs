import { isRetiredSessionFactory } from './factory-authority.mjs';
import { main } from './main.mjs';
import { owners, sandbox } from './sandbox.mjs';

export const isDurableFactory = !isRetiredSessionFactory && sandbox.factoryDurable === true && owners.length > 0;

main(import.meta, () => {
  process.exitCode = isDurableFactory ? 0 : 1;
});
