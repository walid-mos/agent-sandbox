import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [launch] = process.argv.slice(2);
const reply = { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }], stopReason: 'stop' } };
writeFileSync(join(process.env.HOME, `${launch}.session.jsonl`), `${JSON.stringify(reply)}\n`, { mode: 0o600 });
process.stdout.write('Stand-in Pi finished.\n');
