import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexConfiguration } from './codex-configuration.mjs';

const MAGPIE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const directory = path.dirname(path.dirname(process.argv[1]));
const failure = fs.existsSync(path.join(directory, 'failure')) ? fs.readFileSync(path.join(directory, 'failure'), 'utf8') : '';
const [command, ...arguments_] = process.argv.slice(2);
fs.appendFileSync(path.join(directory, 'calls'), command + '\\n');
if (command === 'data') console.log('files: ' + directory);
else if (command === 'model') {
  const member = arguments_[1];
  const upstream = member.includes('deepseek') ? 'deepseek-v4.1-flash' : 'glm-5.3-flash';
  console.log(upstream + ' · what inco is asked for, for ' + member);
  console.log(failure === 'wire-drift' ? '  · unsupported getter output' : '  · magpie and the agents still know it as ' + member + ' · --reset asks for that again');
}
else if (command === 'backup') fs.writeFileSync(arguments_.at(-1), 'fixture encrypted backup', { mode: 0o600 });
else if (command === 'restore') {
  if (failure === 'restore') process.exit(7);
  const snapshot = JSON.parse(fs.readFileSync(arguments_.at(-1), 'utf8'));
  if (failure === 'drift') snapshot.settings.images = false;
  fs.writeFileSync(path.join(directory, 'providers.json'), JSON.stringify(snapshot.providers));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(snapshot.settings));
  if (failure === 'interrupt') process.kill(process.ppid, 'SIGKILL');
} else process.exit(9);
`;

export function codexProcessFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-process-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binaries = join(directory, 'bin');
  const home = join(directory, 'home');
  mkdirSync(binaries);
  mkdirSync(home);
  writeFileSync(join(directory, 'owner'), 'codex-process-fixture', { mode: 0o600 });
  writeFileSync(join(binaries, 'magpie'), MAGPIE);
  chmodSync(join(binaries, 'magpie'), 0o755);
  const managedCodexHome = join(home, '.local/state/agent-sandbox/codex');
  const nativeCodexHome = join(home, '.codex');
  mkdirSync(managedCodexHome, { recursive: true, mode: 0o700 });
  mkdirSync(nativeCodexHome, { recursive: true, mode: 0o700 });
  for (const path of [join(directory, 'providers.json'), join(directory, 'logins.json'), join(managedCodexHome, 'auth.json'), join(nativeCodexHome, 'auth.json')]) {
    writeFileSync(path, '{ "fixture": "owned" }\\n', { mode: 0o600 });
  }
  const before = codexConfiguration();
  const candidate = codexConfiguration();
  candidate.providers.groups[1].members[0] = 'codex/gpt-6.2-sol:medium#original';
  candidate.providers.groups[2].members[0] = 'codex/gpt-6.2-sol:high#original';
  for (const name of ['providers', 'settings']) writeFileSync(join(directory, name + '.json'), JSON.stringify(before[name]), { mode: 0o600 });
  for (const name of ['seed', 'source.json']) writeFileSync(join(directory, name), JSON.stringify(candidate), { mode: 0o600 });
  return { directory, candidate, source: join(directory, 'source.json'), seed: join(directory, 'seed'), journal: join(directory, 'journal'),
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), PATH: binaries + ':' + process.env.PATH, CODEX_FIXTURE_DIRECTORY: directory },
    entry: resolve('session/router-codex-restore.mjs') };
}
