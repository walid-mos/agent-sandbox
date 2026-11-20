import { existsSync, readFileSync } from 'node:fs';
import { assignments } from './environment.mjs';
import { isDurableFactory, isIsolatedFactory, isRetiredSessionFactory } from './factory-mode-facts.mjs';

const launch = assignments(readFileSync(new URL('./launch.env', import.meta.url), 'utf8'));
export { isDurableFactory, isIsolatedFactory, isRetiredSessionFactory };
export const landingRepository = launch.POTS_LANDING_REPOSITORY ?? '';
export const REPORT_SOURCE = launch.POTS_FACTORY_REPORT_SOURCE;
export const LANDING_BRANCH = 'main';
export const isLandingPull = pull => pull.repository.toLowerCase() === landingRepository.toLowerCase() && pull.base === LANDING_BRANCH;

export function requireFactoryRuntime() {
  if (isRetiredSessionFactory) {
    throw new Error('factory: this factory now runs outside the worker session. Complete the operator factory-bootstrap, landing-key and vm-up steps.');
  }
}

export function requireLandingAuthority(repository) {
  if (repository.toLowerCase() !== landingRepository.toLowerCase()) return;
  if (!isDurableFactory) {
    throw new Error('factory: a signed landing needs the durable factory, because its publication is bound to a review generation and to the check inputs of that review.');
  }
  if (!existsSync(new URL('../lib/factory_squash.py', import.meta.url))) {
    throw new Error('factory: the signed landing verifier prerequisite is missing');
  }
  if (launch.POTS_LANDING_SQUASH_ENROLLED !== '1' || !isIsolatedFactory || !existsSync(launch.POTS_LANDING_SOCKET)) {
    throw new Error('factory: host-code publication requires explicit native squash enrollment and the private signer socket in the isolated factory.');
  }
}
