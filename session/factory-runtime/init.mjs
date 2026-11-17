import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FACTORY_BOT, factoryBotHome } from '../factory-identity.mjs';
import { ROUTER_MODEL } from '../models.mjs';

const [routerApi] = process.argv.slice(2);
if (!routerApi) throw new Error('factory init: expected the router API address, which initialize-bot passes.');
const [provider, ...model] = ROUTER_MODEL.split('/');
const directory = join(homedir(), '.pi/agent');
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(join(directory, 'models.json'), JSON.stringify({
  providers: {
    [provider]: {
      baseUrl: routerApi,
      api: 'openai-completions',
      apiKey: 'MAGPIE_API_KEY',
      models: [{ id: model.join('/'), name: 'Factory router', contextWindow: 200000, maxTokens: 65536, reasoning: true, input: ['text', 'image'] }],
    },
  },
}) + '\n', { mode: 0o600 });
if (!existsSync(factoryBotHome())) {
  execFileSync('pots', ['init', '--yes', '--name', FACTORY_BOT.name, '--model', ROUTER_MODEL, '--judge', 'off', '--no-chat', '--no-service'], { stdio: 'inherit' });
}
