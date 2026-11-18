import { isDeepStrictEqual } from 'node:util';
import { main, runOperation } from './main.mjs';
import { routerAnswerPlans } from './router-answers.mjs';
import { readPrivateJson } from './router-configuration.mjs';
import { STANDARD_WIRES } from './router-wires.mjs';

export const CODEX_CONTRACT = 'CODEX_TARGETED_V1';
export const CODEX_POTS = Object.freeze(['accor', 'mastermind', 'nextnode', 'personal']);
export const refuseCodex = reason => new Error(`${CODEX_CONTRACT}: ${reason}, refused. Reconcile privately before another operation.`);
const EFFORTS = { deep: 'medium', expert: 'high' };
const OLD_SOL = 'codex/gpt-6.1-sol';
const NEW_SOL = 'codex/gpt-6.2-sol';

export function validateSnapshot(snapshot) {
  if (snapshot?.format !== 'agent-sandbox-codex-v1' || !snapshot.providers || !snapshot.settings || !snapshot.credentials) {
    throw refuseCodex('unsupported or incomplete configuration');
  }
  const groups = snapshot.providers.groups;
  if (!Array.isArray(groups) || groups.some(group => typeof group?.id !== 'string') || new Set(groups.map(group => group.id)).size !== groups.length) {
    throw refuseCodex('missing, duplicate or unsupported group definitions');
  }
  for (const [member, wire] of Object.entries(STANDARD_WIRES)) {
    if (snapshot.wires?.[member] !== wire) throw refuseCodex('missing standard Inco wire');
  }
  try { routerAnswerPlans(snapshot.providers); } catch { throw refuseCodex('invalid full-health route configuration'); }
}

function solGroup(snapshot, id) {
  const matches = snapshot.providers.groups.filter(group => group.id === id);
  if (matches.length !== 1) throw refuseCodex('missing or duplicate Sol group');
  return matches[0];
}

export function upgradedSnapshot(before) {
  validateSnapshot(before);
  const candidate = structuredClone(before);
  for (const [id, effort] of Object.entries(EFFORTS)) {
    const group = solGroup(candidate, id);
    const expected = `${OLD_SOL}:${effort}`;
    const member = group.members[0];
    if (typeof member !== 'string' || (member !== expected && !/^#[^/\s#]+$/u.test(member.slice(expected.length))) || !member.startsWith(expected)) throw refuseCodex('unexpected original Sol member or effort');
    group.members[0] = NEW_SOL + member.slice(OLD_SOL.length);
  }
  return candidate;
}

export function requireSameSnapshot(expected, actual) {
  validateSnapshot(expected);
  validateSnapshot(actual);
  if (!isDeepStrictEqual(expected, actual)) throw refuseCodex('configuration, credential material or binding drift');
}

export function codexPlan(snapshot) {
  validateSnapshot(snapshot);
  const expert = solGroup(snapshot, 'expert').members[0];
  const prefix = `${NEW_SOL}:${EFFORTS.expert}`;
  const plans = routerAnswerPlans(snapshot.providers);
  if (!expert.startsWith(prefix) || (expert !== prefix && !/^#[^/\s#]+$/u.test(expert.slice(prefix.length))) || plans[0].member !== expert) {
    throw refuseCodex('selected route is not the existing expert Sol member');
  }
  return { contract: CODEX_CONTRACT, target: expert, served: NEW_SOL, claude: 'DEFERRED' };
}

export function planCodexUpgrade(before, candidate) {
  requireSameSnapshot(upgradedSnapshot(before), candidate);
  return codexPlan(candidate);
}

main(import.meta, () => runOperation({
  plan: ([before, candidate]) => {
    const plan = planCodexUpgrade(readPrivateJson(before), readPrivateJson(candidate));
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  },
}, 'usage: router-codex-contract.mjs plan PRIVATE_BEFORE PRIVATE_CANDIDATE'));
