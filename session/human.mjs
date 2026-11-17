import { answerQuestion, cancelDialog, openDialog } from './human-dialogs.mjs';
import { consumePush } from './human-consume.mjs';
import { storeDialogSecret } from './human-secrets.mjs';
import { humanStore } from './human-store.mjs';
import { workers } from './workers.mjs';
import { main } from './main.mjs';

const INPUT_LIMIT = 65_536;

async function input() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new Error('human: input is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('human: unreadable input.'); }
}

function view(dialog) {
  if (!dialog) throw new Error('human: no such dialog.');
  const { id, kind, policy, result, expiresAt, delivery, issue, consumption } = dialog;
  return { id, kind, policy, result, expiresAt, delivery, issue, consumption, isWriting: dialog.writing === true };
}

main(import.meta, async () => {
  const [operation, id] = process.argv.slice(2);
  const operations = {
    open: async () => {
      const requested = await input();
      const worker = requested.source?.type === 'worker' && workers().find(candidate => candidate.name === requested.source.worker);
      return view(await openDialog({ ...requested, served: worker?.servedRequest ?? requested.served }));
    },
    get: () => view(humanStore().get(id)),
    answer: async () => view(await answerQuestion(id, await input())),
    secret: async () => view(await storeDialogSecret(id, await input())),
    consume: async () => view(await consumePush(id, await input())),
    cancel: async () => view(await cancelDialog(id)),
    pause: async () => view(await cancelDialog(id, 'paused')),
  };
  if (!Object.hasOwn(operations, operation)) throw new Error('usage: human.mjs open|answer ID|secret ID|consume ID <json | get|cancel|pause ID');
  process.stdout.write(`${JSON.stringify(await operations[operation]())}\n`);
});
