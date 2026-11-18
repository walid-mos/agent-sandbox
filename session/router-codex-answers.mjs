import { requestRouterAnswer } from './router-answers.mjs';
import { CODEX_CONTRACT, codexPlan, requireSameSnapshot } from './router-codex-contract.mjs';
import { readPrivateJson, readRouterConfiguration } from './router-configuration.mjs';
import { main } from './main.mjs';

export async function* codexAnswers(snapshot, routerApi) {
  const plan = codexPlan(snapshot);
  let result;
  try {
    result = await requestRouterAnswer(routerApi, { group: CODEX_CONTRACT, target: plan.target, member: plan.target });
  } catch {
    throw new Error(`${CODEX_CONTRACT}: direct Codex validation failed, outcome UNKNOWN. No retry. Claude DEFERRED.`);
  }
  if (result.status !== 200 || !result.answer?.choices?.length || result.served !== plan.served) {
    throw new Error(`${CODEX_CONTRACT}: direct Codex validation failed. No retry. Claude DEFERRED.`);
  }
  yield `${CODEX_CONTRACT}: direct Codex served ${plan.served}`;
  yield `${CODEX_CONTRACT}: Claude DEFERRED, group runtime and fallbacks untested`;
}

main(import.meta, async () => {
  const [expectedPath, routerApi] = process.argv.slice(2);
  const snapshot = readRouterConfiguration();
  requireSameSnapshot(readPrivateJson(expectedPath), snapshot);
  for await (const line of codexAnswers(snapshot, routerApi)) process.stdout.write(`${line}\n`);
});
