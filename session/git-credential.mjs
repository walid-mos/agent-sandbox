import { readFileSync } from 'node:fs';
import { assignments } from './environment.mjs';

export function answerCredentialRequest(action, tokenFor) {
  if (action !== 'get') return;
  const request = assignments(readFileSync(0, 'utf8'));
  if (request.protocol !== 'https' || request.host !== 'github.com') return;
  process.stdout.write(`username=x-access-token\npassword=${tokenFor(request.path ?? '')}\n\n`);
}
