export function requireSecretKeys(keys, values) {
  const missing = keys.filter(key => typeof values[key] !== 'string' || !values[key].trim());
  if (missing.length) throw new Error(`human: missing secret keys: ${missing.join(', ')}.`);
}
