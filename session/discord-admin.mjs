import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discordAdminApi } from './discord-admin-api.mjs';
import { discordAdminApprovals } from './discord-admin-approvals.mjs';
import { inspectDiscord } from './discord-admin-inspect.mjs';
import { ADMIN_OPERATIONS } from './discord-admin-operations.mjs';
import { discordAccount, discoverProtection } from './discord-admin-runtime.mjs';
import { administerDiscord } from './discord-admin-service.mjs';
import { HUMAN_HOME, humanStore } from './human-store.mjs';
import { main } from './main.mjs';
import { botHome, isMastermind, sandbox } from './sandbox.mjs';

function actions() {
  return Object.fromEntries(Object.entries(ADMIN_OPERATIONS).map(([action, operation]) => [action, {
    permission: operation.permission, fields: Object.keys(operation.fields), required: operation.required, targets: operation.targets,
  }]));
}

function readInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')); }
  catch { throw new Error('discord-admin: provide one JSON request on stdin.'); }
}

function dispatch(mode, input, dependencies) {
  const { approvals, api, protection } = dependencies;
  const handlers = {
    register: () => approvals.register(input),
    inspect: () => inspectDiscord(input, { api, guildId: protection.guildId }),
    operate: () => administerDiscord(input, dependencies),
    approve: () => administerDiscord(approvals.approvedRequest(input.approval), dependencies),
  };
  return handlers[mode]();
}

main(import.meta, async () => {
  if (!isMastermind) throw new Error('discord-admin: only the Mastermind pot runs this command.');
  const mode = process.argv[2];
  if (mode === 'actions') {
    process.stdout.write(`${JSON.stringify(actions())}\n`);
    return;
  }
  if (!['operate', 'register', 'inspect', 'approve'].includes(mode)) throw new Error('discord-admin: use actions, operate, register, approve or inspect. Supply JSON on stdin.');
  const input = readInput();
  const account = discordAccount(botHome);
  const api = discordAdminApi(account.secrets);
  const protection = await discoverProtection({ api, config: sandbox, primaryHome: botHome, stateDirectory: join(homedir(), '.config/agent-sandbox/discord-admin') });
  const approvals = discordAdminApprovals({ clicks: humanStore(join(HUMAN_HOME, 'discord')), pending: humanStore(join(HUMAN_HOME, 'discord-admin')),
    channelAccount: account.id, guildId: protection.guildId });
  const result = await dispatch(mode, input, { api, protection, approvals });
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
