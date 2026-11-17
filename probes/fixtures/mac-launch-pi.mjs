import { writeFileSync } from 'node:fs';
import { gateStore } from '../../mac/launch-store.mjs';

const [folder, launch] = process.argv.slice(2);
const reply = { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }], stopReason: 'stop' } };
writeFileSync(gateStore(folder).session(launch), `${JSON.stringify(reply)}\n`, { mode: 0o600 });
process.stdout.write('Stand-in Pi finished.\n');
