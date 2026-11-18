import { main, runOperation } from './main.mjs';
import { routerAnswerPlans } from './router-answers.mjs';
import { readPrivateJson } from './router-configuration.mjs';
import { STANDARD_WIRES } from './router-wires.mjs';
import { CODEX_CONTRACT, refuseCodex } from './codex-contract-names.mjs';
import { requireArray, requireEqual, requireObject, requireString } from './codex-validation.mjs';
export { CODEX_CONTRACT, CODEX_POTS, refuseCodex } from './codex-contract-names.mjs';
const EFFORTS = { deep: 'medium', expert: 'high' };
const OLD_SOL = 'codex/gpt-6.1-sol';
const NEW_SOL = 'codex/gpt-6.2-sol';

function groupId(group) {
  requireObject(group, 'unsupported group definition');
  requireString(group.id, 'missing group id');
  return group.id;
}

export function validateSnapshot(snapshot) {
  requireObject(snapshot, 'unsupported configuration snapshot');
  requireEqual('agent-sandbox-codex-v1', snapshot.format, 'unsupported configuration format');
  for (const field of ['providers', 'settings', 'credentials', 'wires']) requireObject(snapshot[field], 'incomplete configuration');
  const groups = snapshot.providers.groups;
  requireArray(groups, 'group definitions missing');
  requireEqual(groups.length, new Set(groups.map(groupId)).size, 'duplicate group definitions');
  for (const [member, wire] of Object.entries(STANDARD_WIRES)) requireEqual(wire, snapshot.wires[member], 'missing standard Inco wire');
  try { routerAnswerPlans(snapshot.providers); } catch { throw refuseCodex('invalid full-health route configuration'); }
}

function requireSelectedMember(member, prefix) {
  const reason = 'unexpected Sol member, account selector or effort';
  requireString(member, reason);
  requireEqual(true, member.startsWith(prefix), reason);
  const suffix = member.slice(prefix.length);
  if (suffix && !/^#[^/\s#]+$/u.test(suffix)) throw refuseCodex(reason);
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
    requireSelectedMember(member, expected);
    group.members[0] = NEW_SOL + member.slice(OLD_SOL.length);
  }
  return candidate;
}

export function requireSameSnapshot(expected, actual) {
  validateSnapshot(expected);
  validateSnapshot(actual);
  requireEqual(expected, actual, 'configuration, credential material or binding drift');
}

export function codexPlan(snapshot) {
  validateSnapshot(snapshot);
  const expert = solGroup(snapshot, 'expert').members[0];
  const prefix = `${NEW_SOL}:${EFFORTS.expert}`;
  const plans = routerAnswerPlans(snapshot.providers);
  requireSelectedMember(expert, prefix);
  requireEqual(expert, plans[0].member, 'selected route is not the existing expert Sol member');
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
