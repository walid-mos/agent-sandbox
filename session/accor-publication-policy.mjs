export const ACCOR_FIRST_PUBLICATION = 'accor-first-publication';

export function accorPublicationPolicy(sandbox) {
  const { publicationPolicy, rules, sources } = sandbox;
  if (publicationPolicy === undefined) return undefined;
  if (publicationPolicy !== ACCOR_FIRST_PUBLICATION || !Array.isArray(sources) || !sources.includes('accor')
    || typeof rules !== 'string' || rules.length === 0) {
    throw new Error('sandbox: publicationPolicy requires the Accor first-publication policy, the selected Accor source and a configured rules file.');
  }
  return publicationPolicy;
}
