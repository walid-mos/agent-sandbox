import { join } from 'node:path';

export function fixtureSandbox(home) {
  const botId = 'proof';
  const potsHome = join(home, '.pots');
  const potsBotHome = id => join(potsHome, 'bots', id);
  const sandbox = { bot: botId, owners: { proof: {} }, doors: { mastermind: 'Fixture coordinator' } };
  return { sandbox, botId, owners: Object.keys(sandbox.owners), isMastermind: false, potsHome, potsBotHome, botHome: potsBotHome(botId) };
}
