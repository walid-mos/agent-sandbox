import { readFileSync } from 'node:fs';
import { sourceFor } from './agent-sources.mjs';
import { main } from './main.mjs';

function readRequest() {
  return Object.fromEntries(readFileSync(0, 'utf8').split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

const isGitHubRequest = request => request.protocol === 'https' && request.host === 'github.com';

function tokenFor(path) {
  const source = sourceFor(path.replace(/\.git$/, ''));
  if (!source) throw new Error('source-credential: repository is outside the approved agent sources.');
  const token = process.env[source.credential];
  if (!token) throw new Error(`source-credential: ${source.credential} is absent. Fetch through source-fetch.`);
  return token;
}

main(import.meta, () => {
  if (process.argv[2] !== 'get') return;
  const request = readRequest();
  if (!isGitHubRequest(request)) return;
  process.stdout.write(`username=x-access-token\npassword=${tokenFor(request.path ?? '')}\n\n`);
});
