import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_CONTRACT } from '../../session/router-codex-contract.mjs';
import { sha256, SOURCE_PARENT } from '../../session/codex-review.mjs';

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = join(DIRECTORY, '../..');
const MANIFEST = 'resources/codex-targeted-v1/manifest.json';
const RESOURCE = /^(?:bin|session|lib|vm|proxmox|colima|mac|herdr|sealskin|probes|resources\/codex-targeted-v1)\//u;
const files = execFileSync('git', ['-C', REPOSITORY, 'ls-files', '--cached', '-z'], { encoding: 'utf8' }).split('\0')
  .filter(path => path && RESOURCE.test(path) && path !== MANIFEST).sort();
const resources = Object.fromEntries(files.map(path => {
  const contents = readFileSync(join(REPOSITORY, path));
  return [path, { sha256: sha256(contents), bytes: contents.length }];
}));
writeFileSync(join(REPOSITORY, MANIFEST), JSON.stringify({
  contract: CODEX_CONTRACT,
  sourceParent: SOURCE_PARENT,
  sourceTipAuthority: 'Exact external scope.source.tip and ordered scope.source.allowedCommits, never SIGN_PARENT',
  resources,
}, null, 2) + '\n');
process.stdout.write(`CODEX_TARGETED_V1: hashed ${files.length} public source resources\n`);
