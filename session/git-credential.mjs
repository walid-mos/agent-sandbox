import { readFileSync } from 'node:fs';

export function answerCredentialRequest(action, tokenFor) {
  if (action !== 'get') return;
  const request = Object.fromEntries(readFileSync(0, 'utf8').split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  if (request.protocol !== 'https' || request.host !== 'github.com') return;
  process.stdout.write(`username=x-access-token\npassword=${tokenFor(request.path ?? '')}\n\n`);
}
