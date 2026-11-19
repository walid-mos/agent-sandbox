import { potsBotHome } from './pots-home.mjs';

export const FACTORY_BOT = { name: 'Factory', id: 'factory' };
export const factoryBotHome = () => potsBotHome(FACTORY_BOT.id);
