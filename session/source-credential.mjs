import { sourceFor } from './agent-sources.mjs';
import { answerCredentialRequest } from './git-credential.mjs';
import { main } from './main.mjs';

function tokenFor(path) {
  const source = sourceFor(path.replace(/\.git$/, ''));
  if (!source?.selected || !source.credential) throw new Error('source-credential: repository is not a private source this sandbox selects.');
  const token = process.env[source.credential];
  if (!token) throw new Error(`source-credential: ${source.credential} is absent. Fetch through source-fetch.`);
  return token;
}

main(import.meta, () => answerCredentialRequest(process.argv[2], tokenFor));
