import { spawn } from 'node:child_process';
import { checkDiscordPolicy, LAUNCH_POLICY } from '../session/human-contract.mjs';
import { OPEN, shownRequest } from '../session/launch-contract.mjs';
import { main } from '../session/main.mjs';
import { CLAIM_MAX_AGE_MS, CLAIMED, verifyOffer } from './launch-approval.mjs';
import { executionFingerprint, executionScope } from './launch-execution-contract.mjs';
import { dropExecutionIdentity, executionEnvironment, prepareRun, runPaths, sandboxProfile } from './launch-isolation.mjs';
import { checkProtectedInstallation } from './launch-protection.mjs';
import { loadSettings, STATE_HOME } from './launch-settings.mjs';
import { gateStore } from './launch-store.mjs';

export function piArguments(offer, settings, claim, session, now) {
  executionScope(settings, offer.request.acts);
  if (claim?.executionDigest !== executionFingerprint(settings)) throw new Error('mac-launch: no claim covers this execution scope.');
  checkDiscordPolicy(LAUNCH_POLICY, settings.humanDiscord);
  const age = now - claim?.decidedAt;
  const isClaim = claim?.state === CLAIMED && claim.userId === settings.humanDiscord.userId && age >= 0 && age <= CLAIM_MAX_AGE_MS;
  if (!isClaim) throw new Error('mac-launch: no fresh claim by the operator covers this launch. No Pi started.');
  const { request, prompt } = verifyOffer(shownRequest(offer.request, offer.prompt, OPEN), offer.request, settings, claim.decidedAt);
  if (!['launch', 'pot', 'target', 'digest'].every(key => request[key] === claim[key])) throw new Error('mac-launch: the claim names another prompt, pot or Mac. No Pi started.');
  const frame = `This prompt was approved for ${settings.label} from pot ${request.pot}. Declared acts: ${request.acts.join(', ') || 'none'}. Cost declared: ${request.cost || 'not stated'}. You run in a restricted execution account. Only the selected work and delegated capabilities are available. A new instruction from a pot requires a new approval. Your final reply returns to the pot as a report.`;
  return ['--session', session, '--append-system-prompt', frame, '--provider', settings.execution.model.provider, '--model', settings.execution.model.name,
    '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--', prompt];
}

main(import.meta, () => {
  const settings = loadSettings();
  checkProtectedInstallation(settings);
  const [id, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('mac-launch: execution accepts only the claimed launch ID.');
  const store = gateStore(STATE_HOME);
  const offer = store.get(id);
  if (!offer) throw new Error('mac-launch: no gate offer covers this launch.');
  const arguments_ = piArguments(offer, settings, store.decision(id), runPaths(id).session, Date.now());
  store.beginExecution(id);
  const run = prepareRun(settings, id, offer.request.acts);
  const env = executionEnvironment(settings, run, offer.request.acts);
  const profile = sandboxProfile(settings, run, offer.request.acts);
  dropExecutionIdentity(settings.execution);
  process.chdir(settings.directory);
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, settings.tools.node, settings.tools.pi, ...arguments_], { stdio: 'inherit', env });
  child.on('error', () => { process.stderr.write('mac-launch: native sandbox or Pi could not start. No fallback is available.\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
});
