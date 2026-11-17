import { fileURLToPath } from 'node:url';

export const DOOR_COMMAND = fileURLToPath(new URL('./pots', import.meta.url));
