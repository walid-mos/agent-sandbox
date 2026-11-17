import { existsSync, readFileSync } from 'node:fs';
import { assignments } from './environment.mjs';
import { botId } from './sandbox.mjs';

const launch = assignments(readFileSync(new URL('./launch.env', import.meta.url), 'utf8'));
export const isIsolatedFactory = process.env.POTS_ISOLATED_FACTORY === '1';
export const isRetiredSessionFactory = botId === launch.POTS_SIGNING_FACTORY_BOT && !isIsolatedFactory;
export const landingRepository = launch.POTS_LANDING_REPOSITORY;
export const REPORT_SOURCE = launch.POTS_FACTORY_REPORT_SOURCE;
export const LANDING_BRANCH = 'main';
export const isLandingPull = pull => pull.repository === landingRepository && pull.base === LANDING_BRANCH;

export function requireFactoryRuntime() {
  if (isRetiredSessionFactory) {
    throw new Error('factory: this factory now runs outside the worker session. Complete the operator factory-bootstrap, landing-key and vm-up steps.');
  }
}

export function requireLandingAuthority(repository) {
  if (repository === landingRepository && (!isIsolatedFactory || !existsSync(launch.POTS_LANDING_SOCKET))) {
    throw new Error('factory: host-code publication requires the private signer socket in the isolated factory.');
  }
}
