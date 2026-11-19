import { fileURLToPath } from 'node:url';
import { command } from './run.mjs';

const CLIENT = fileURLToPath(new URL('./factory-channel', import.meta.url));

export function askFactory(kind, request) {
  return JSON.parse(command('python3', [CLIENT, kind], { input: JSON.stringify(request) }));
}
