import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requireCodexCapability } from './codex-catalog.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/codex-rust-v0.169.1-models.json', import.meta.url), 'utf8'));
const fixtureVersion = fixture.source.tag.replace(/^rust-v/u, '');
const fixtureModel = fixture.models[0];

function pinnedCodexVersion() {
  const bootstrap = readFileSync(new URL('./bootstrap', import.meta.url), 'utf8');
  const version = bootstrap.match(/^CODEX_VERSION=(.+)$/mu)?.[1];
  assert.ok(version);
  return version;
}

const catalog = () => ({ models: [{
  slug: fixtureModel.slug,
  visibility: fixtureModel.visibility,
  supported_in_api: fixtureModel.supported_in_api,
  supported_reasoning_levels: structuredClone(fixtureModel.supported_reasoning_levels),
}] });

test('pinned bundled catalog fixture comes from a Codex release that supports GPT 6.2 Sol', () => {
  assert.equal(fixture.source.commit, 'c376cf7396eff83ce4c6ac61b9553df142e7a0be');
  assert.equal(fixture.source.sha256, 'd50b6749506d97e5f334dbabcb666eb1689f423cf3e88cfabdcf3c536b873068');
  assert.equal(fixture.sourceModelCount, 14);
  assert.equal(fixtureModel.minimal_client_version, '0.166.0');
  assert.equal(fixtureVersion, pinnedCodexVersion());
  assert.equal(requireCodexCapability(catalog(), fixtureVersion, pinnedCodexVersion()), 'gpt-6.2-sol');
});

test('bundled catalog refuses absent, stale, hidden, unsupported, duplicate or malformed capability', () => {
  const version = pinnedCodexVersion();
  const cases = [
    { models: [{ ...fixtureModel, slug: 'gpt-6.1-sol' }] },
    { models: [] },
    { models: [{ ...fixtureModel, visibility: 'hide' }] },
    { models: [{ ...fixtureModel, supported_in_api: false }] },
    { models: [{ ...fixtureModel, supported_reasoning_levels: [] }] },
    { models: [fixtureModel, fixtureModel] },
    { models: [{ ...fixtureModel, supported_reasoning_levels: [{ effort: 'high' }] }] },
  ];
  for (const value of cases) assert.throws(() => requireCodexCapability(value, version, version), /Codex (?:catalog|model) .*refused/u);
  assert.throws(() => requireCodexCapability(catalog(), version, '0.168.0'), /Codex catalog .*refused/u);
});
