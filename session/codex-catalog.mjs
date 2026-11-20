import { requireArray, requireEqual, requireObject, requireString } from './codex-validation.mjs';
import { refuseCodex } from './codex-contract-names.mjs';

const MODEL = 'gpt-6.2-sol';
const EFFORT = 'high';

function validateCatalog(catalog) {
  requireObject(catalog, 'Codex catalog is missing or malformed');
  requireArray(catalog.models, 'Codex catalog is missing or malformed');
  for (const model of catalog.models) {
    requireObject(model, 'Codex catalog contains malformed model metadata');
    requireString(model.slug, 'Codex catalog contains a model without an id');
    requireString(model.visibility, 'Codex catalog contains a model without visibility');
    if (typeof model.supported_in_api !== 'boolean') throw refuseCodex('Codex catalog has malformed API capability');
    requireArray(model.supported_reasoning_levels, 'Codex catalog lacks reasoning capability metadata');
    for (const level of model.supported_reasoning_levels) {
      requireObject(level, 'Codex catalog has malformed reasoning capability metadata');
      requireString(level.effort, 'Codex catalog has malformed reasoning capability metadata');
      requireString(level.description, 'Codex catalog has incomplete reasoning capability metadata');
    }
  }
}

export function requireCodexCapability(catalog, expectedVersion, actualVersion) {
  requireEqual(expectedVersion, actualVersion, 'Codex catalog is stale for the pinned CLI');
  validateCatalog(catalog);
  const matches = catalog.models.filter(model => model.slug === MODEL);
  requireEqual(1, matches.length, 'Codex catalog capability is absent or ambiguous');
  const [model] = matches;
  requireEqual('list', model.visibility, 'Codex model is not visible in the pinned catalog');
  requireEqual(true, model.supported_in_api, 'Codex model is unsupported in API');
  const high = model.supported_reasoning_levels.filter(level => level.effort === EFFORT);
  requireEqual(1, high.length, 'Codex model does not list the requested high effort');
  return MODEL;
}
