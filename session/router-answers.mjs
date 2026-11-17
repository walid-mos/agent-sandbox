import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from './main.mjs';
import { MAX_GROUP, ROUTER_GROUP } from './models.mjs';

const CHECKED_GROUPS = [ROUTER_GROUP, MAX_GROUP];
const GROUP_PREFIX = 'group/';
const QUESTION = 'Reply only OK.';
const ANSWER_TOKENS = 16;
const ANSWER_TIMEOUT_MS = 120 * 1000;
// Magpie names the provider/model that answered in this header; the body's model echoes the group asked.
const SERVED_HEADER = 'X-Magpie-Model';

const picksInOrder = group => group.routing === 'order' && !group.rules?.length;
const memberModel = member => member.replace(/#[^/]+$/u, '').replace(/:fast$/u, '')
  .replace(/:(?:none|minimal|low|medium|high|xhigh|max)(?:\+(?:none|minimal|low|medium|high|xhigh|max))*$/u, '');
const badSeed = (group, problem) => new Error(`router-restore: ${group}: ${problem}. Check the seeded groups.`);

function firstMemberChain(groups, groupId) {
  const chain = [];
  let member = groupId;
  while (member.startsWith(GROUP_PREFIX)) {
    const group = groups.find(candidate => GROUP_PREFIX + candidate.id === member);
    if (!group || group.hidden || !group.members?.length) throw badSeed(groupId, `${member} is missing or empty`);
    if (chain.includes(group)) throw badSeed(groupId, `cycle at ${member}`);
    chain.push(group);
    [member] = group.members;
    if (typeof member !== 'string') throw badSeed(groupId, 'first member is not a model or group');
  }
  return { chain, member };
}

function answerPlan(groups, groupId) {
  const { chain, member } = firstMemberChain(groups, groupId);
  const settled = chain.slice(chain.findLastIndex(group => !picksInOrder(group)) + 1);
  if (!settled.length || /[*?\[\]]|^re:|^free:/u.test(member)) throw badSeed(groupId, 'no predictable first member');
  return { group: groupId, target: GROUP_PREFIX + settled[0].id, member };
}

const throughGroup = ({ group, target }) => target === group ? '' : ` through ${target}`;

async function ask(routerApi, plan) {
  let served = 'no served model';
  try {
    const response = await fetch(`${routerApi}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: plan.target, messages: [{ role: 'user', content: QUESTION }], max_tokens: ANSWER_TOKENS, stream: false }),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
    served = response.headers.get(SERVED_HEADER) || served;
    return { status: response.status, served, answer: await response.json() };
  } catch {
    throw new Error(`router-restore: ${plan.group}${throughGroup(plan)} expected ${plan.member} and got ${served}: request failed or response was unreadable. Check the router.`);
  }
}

function verdict({ group, target, member }, { status, served, answer }) {
  const through = throughGroup({ group, target });
  if (status !== 200 || !answer?.choices?.length) {
    throw new Error(`router-restore: ${group}${through} expected ${member} and got no answer (HTTP ${status}, selected ${served ?? 'no served model'}). Check that model on its provider and credential freshness.`);
  }
  const expected = memberModel(member);
  if (served !== expected) {
    throw new Error(`router-restore: ${group}${through} expected ${member} and got ${served ?? 'no served model'}. Its first member gave no answer: check that model on its provider and the vault credentials.`);
  }
  return `router-restore: ${group} answers${through} with ${served}`;
}

export async function* routerAnswers({ groups }, routerApi) {
  const plans = CHECKED_GROUPS.map(group => answerPlan(groups, group));
  for (const plan of plans) yield verdict(plan, await ask(routerApi, plan));
}

function restoredConfiguration() {
  try {
    const directory = execFileSync('magpie', ['data'], { encoding: 'utf8' }).match(/^files: (.+)$/mu)[1];
    return JSON.parse(readFileSync(join(directory, 'providers.json'), 'utf8'));
  } catch {
    // providers.json holds keys, so a JSON parse error must never quote its contents.
    throw new Error('router-restore: cannot read the restored Magpie configuration. Check magpie data and providers.json.');
  }
}

main(import.meta, async () => {
  for await (const line of routerAnswers(restoredConfiguration(), process.argv[2])) process.stdout.write(`${line}\n`);
});
