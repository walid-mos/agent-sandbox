import { requestRouterAnswer } from './router-answers.mjs';
import { CODEX_CONTRACT, codexPlan, requireSameSnapshot } from './router-codex-contract.mjs';
import { readLocalCredentialBytes, readPrivateJson, readRouterConfiguration, requireCredentialBytesEqual } from './router-configuration.mjs';
import { main } from './main.mjs';
import { requireEqual } from './codex-validation.mjs';

function requireExactCodexAnswer(result, plan) {
  const reason = 'direct Codex validation failed. No retry. Claude DEFERRED';
  requireEqual(200, result.status, reason);
  if (!Array.isArray(result.answer?.choices) || !result.answer.choices.length) throw new Error(`CODEX_TARGETED_V1: ${reason}.`);
  requireEqual(plan.served, result.served, reason);
}

export async function* codexAnswers(snapshot, routerApi, captureCredentials = readLocalCredentialBytes) {
  const plan = codexPlan(snapshot);
  const credentialBytes = captureCredentials();
  let result;
  try {
    result = await requestRouterAnswer(routerApi, { group: CODEX_CONTRACT, target: plan.target, member: plan.target, account: plan.account });
  } catch {
    requireCredentialBytesEqual(credentialBytes, captureCredentials());
    throw new Error(`${CODEX_CONTRACT}: direct Codex validation failed, outcome UNKNOWN. No retry. Claude DEFERRED.`);
  }
  requireCredentialBytesEqual(credentialBytes, captureCredentials());
  requireExactCodexAnswer(result, plan);
  yield `${CODEX_CONTRACT}: direct Codex served ${plan.served}`;
  yield `${CODEX_CONTRACT}: account constraint applied, served account unverified`;
  yield `${CODEX_CONTRACT}: Claude DEFERRED, group runtime and fallbacks untested`;
}

main(import.meta, async () => {
  const [expectedPath, routerApi] = process.argv.slice(2);
  const snapshot = readRouterConfiguration();
  requireSameSnapshot(readPrivateJson(expectedPath), snapshot);
  for await (const line of codexAnswers(snapshot, routerApi)) process.stdout.write(`${line}\n`);
});
