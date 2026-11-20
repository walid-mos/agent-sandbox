import { homedir } from 'node:os';
import { join } from 'node:path';

export const potsHome = join(homedir(), '.pots');
export const potsBotHome = id => join(potsHome, 'bots', id);
