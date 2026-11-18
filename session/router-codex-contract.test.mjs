import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexConfiguration } from '../probes/fixtures/codex-configuration.mjs';

function plan(t, candidate) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = join(directory, 'before.json');
  const after = join(directory, 'after.json');
  writeFileSync(before, JSON.stringify(codexConfiguration()), { mode: 0o600 });
  writeFileSync(after, JSON.stringify(candidate), { mode: 0o600 });
  return spawnSync(process.execPath, ['session/router-codex-contract.mjs', 'plan', before, after], { encoding: 'utf8' });
}

function candidate() {
  const snapshot = codexConfiguration();
  snapshot.providers.groups[1].members[0] = 'codex/gpt-6.2-sol:medium#original';
  snapshot.providers.groups[2].members[0] = 'codex/gpt-6.2-sol:high#original';
  return snapshot;
}

test('offline CLI approves only the two Sol replacements and returns a direct exact original-account high-effort target', t => {
  const result = plan(t, candidate());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: 'CODEX_TARGETED_V1', target: 'codex/gpt-6.2-sol:high#original', served: 'codex/gpt-6.2-sol', claude: 'DEFERRED',
  });
});

test('offline CLI refuses unrelated route, order, effort, feature, provider, credential and wire drift without printing private input', t => {
  const changes = [
    snapshot => snapshot.providers.groups[3].members.reverse(),
    snapshot => { snapshot.providers.groups[2].members[0] = 'codex/gpt-6.2-sol:medium#original'; },
    snapshot => { snapshot.providers.groups[2].members[0] = 'codex/gpt-6.2-sol:high#replacement'; },
    snapshot => { snapshot.settings.images = false; },
    snapshot => { snapshot.providers.providers[0].headers['X-Fixture'] = 'private-drift'; },
    snapshot => { snapshot.providers.accountBindings.codex = '/replacement/auth.json'; },
    snapshot => { snapshot.credentials.codex.tokens.access_token = 'private-drift'; },
    snapshot => { delete snapshot.wires['inco/glm-5.3-flash:fast']; },
  ];
  for (const change of changes) {
    const snapshot = candidate();
    change(snapshot);
    const result = plan(t, snapshot);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CODEX_TARGETED_V1: .*refused/u);
    assert.doesNotMatch(result.stdout + result.stderr, /private-drift|fixture-only|fixture-key/u);
  }
});
