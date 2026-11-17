import { homedir } from 'node:os';
import { join } from 'node:path';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
export const factoryBotHome = () => join(homedir(), '.pots', 'bots', FACTORY_BOT.id);
