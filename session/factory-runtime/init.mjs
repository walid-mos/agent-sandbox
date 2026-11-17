import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROUTER_MODEL } from '../models.mjs';

const [provider, ...model] = ROUTER_MODEL.split('/');
const directory = join(homedir(), '.pi/agent');
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(join(directory, 'models.json'), JSON.stringify({
  providers: {
    [provider]: {
      baseUrl: 'http://127.0.0.1:3425/v1',
      api: 'openai-completions',
      apiKey: 'MAGPIE_API_KEY',
      models: [{ id: model.join('/'), name: 'Factory router', contextWindow: 200000, maxTokens: 65536, reasoning: true, input: ['text', 'image'] }],
    },
  },
}) + '\n', { mode: 0o600 });
