import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discordAdminApi } from './discord-admin-api.mjs';
import { requireDiscordAdminEnabled } from './discord-admin-enabled.mjs';
import { discordAdminApprovals } from './discord-admin-approvals.mjs';
import { inspectDiscord } from './discord-admin-inspect.mjs';
import { ADMIN_OPERATIONS, ADMIN_REQUEST_FIELDS } from './discord-admin-operations.mjs';
import { ADMIN_APPROVAL_RULES } from './discord-admin-policy.mjs';
import { discordAccount, discoverProtection } from './discord-admin-runtime.mjs';
import { administerDiscord } from './discord-admin-service.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { main } from './main.mjs';
import { botHome, isMastermind, sandbox } from './sandbox.mjs';

function actions() {
  const operations = Object.fromEntries(Object.entries(ADMIN_OPERATIONS).map(([action, operation]) => [action, {
    permission: operation.permission, fields: Object.keys(operation.fields), required: operation.required, targets: operation.targets,
    optionalTargets: operation.optionalTargets, alwaysRequiresApproval: operation.approval,
  }]));
  return { requestFields: ADMIN_REQUEST_FIELDS, approvalRules: ADMIN_APPROVAL_RULES.map(rule => rule.description), operations };
}

function readInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')); }
  catch { throw new Error('discord-admin: provide one JSON request on stdin.'); }
}

const MODES = {
  operate: (input, dependencies) => administerDiscord(input, dependencies),
  register: (input, { approvals }) => approvals.register(input),
  approve: (input, dependencies) => administerDiscord(dependencies.approvals.approvedRequest(input.approval), dependencies),
  inspect: (input, { api, protection }) => inspectDiscord(input, { api, guildId: protection.guildId }),
};
const USAGE_MODES = ['actions', ...Object.keys(MODES)];

async function connect() {
  const account = discordAccount(botHome);
  const api = discordAdminApi(account.secrets);
  const protection = await discoverProtection({ api, config: sandbox, primaryHome: botHome, stateDirectory: join(homedir(), '.config/agent-sandbox/discord-admin') });
  const approvals = discordAdminApprovals({ clicks: humanStore(join(HUMAN_HOME, 'discord')), pending: humanStore(join(HUMAN_HOME, 'discord-admin')),
    channelAccount: account.id, guildId: protection.guildId, api });
  return { api, protection, approvals };
}

async function run(mode) {
  if (mode === 'actions') return actions();
  if (!Object.hasOwn(MODES, mode)) throw new Error(`discord-admin: use ${USAGE_MODES.slice(0, -1).join(', ')} or ${USAGE_MODES.at(-1)}. Supply JSON on stdin.`);
  const input = readInput();
  return MODES[mode](input, await connect());
}

main(import.meta, async () => {
  if (!isMastermind) throw new Error('discord-admin: only the Mastermind pot runs this command.');
  requireDiscordAdminEnabled(sandbox);
  process.stdout.write(`${JSON.stringify(await run(process.argv[2]))}\n`);
});
