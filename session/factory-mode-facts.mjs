import { readFileSync } from 'node:fs';
import { assignments } from './environment.mjs';
import { botId, owners, sandbox } from './sandbox.mjs';

const launch = assignments(readFileSync(new URL('./launch.env', import.meta.url), 'utf8'));

export const isIsolatedFactory = process.env.POTS_ISOLATED_FACTORY === '1';
export const isRetiredSessionFactory = Boolean(launch.POTS_SIGNING_FACTORY_BOT) && botId === launch.POTS_SIGNING_FACTORY_BOT && !isIsolatedFactory;
export const isDurableFactory = !isRetiredSessionFactory && sandbox.factoryDurable === true && owners.length > 0;
