import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireCodexCapability } from './codex-catalog.mjs';

const model = {
  slug: 'gpt-6.2-sol', display_name: 'GPT 6.2 Sol', description: null,
  supported_reasoning_levels: [{ effort: 'high', description: 'High reasoning' }],
  shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
  availability_nux: null, upgrade: null, include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false, include_apps_usage_instructions: true,
  supports_reasoning_summary_parameter: true, support_verbosity: false, default_verbosity: null,
  apply_patch_tool_type: null, web_search_tool_type: 'text',
  truncation_policy: { mode: 'tokens', limit: 10000 }, supports_image_detail_original: false,
  experimental_supported_tools: [],
};
const catalog = () => ({ models: [structuredClone(model)] });

test('bundled catalog admits only one visible API model with the requested reasoning effort', () => {
  assert.equal(requireCodexCapability(catalog(), '0.169.0', '0.169.0'), 'gpt-6.2-sol');
});

test('bundled catalog refuses absent, stale, hidden, unsupported, duplicate or malformed capability', () => {
  const cases = [
    { models: [{ ...model, slug: 'gpt-6.1-sol' }] },
    { models: [] },
    { models: [{ ...model, visibility: 'hide' }] },
    { models: [{ ...model, supported_in_api: false }] },
    { models: [{ ...model, supported_reasoning_levels: [] }] },
    { models: [model, model] },
    { models: [{ ...model, supported_reasoning_levels: [{ effort: 'high' }] }] },
  ];
  for (const value of cases) assert.throws(() => requireCodexCapability(value, '0.169.0', '0.169.0'), /Codex (?:catalog|model) .*refused/u);
  assert.throws(() => requireCodexCapability(catalog(), '0.169.0', '0.168.0'), /Codex catalog .*refused/u);
});
