import { isLabel, optionOf, policyOf } from './human-contract.mjs';

// The bot asks the person to choose by ending a message with a fenced `question` block of JSON, which the pane draws as buttons.
const BLOCK = /^```question[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;
const MIN_OPTIONS = 2;

function parsedBlock(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** The options of a block that asks a real question, trimmed, or null: at least two, each with a distinct one-line label. */
function optionsOf(asked) {
  if (asked?.free === true) return [];
  if (!Array.isArray(asked?.options) || asked.options.length < MIN_OPTIONS) return null;
  const options = asked.options.map(optionOf);
  if (!options.every(option => isLabel(option?.label))) return null;
  const trimmed = options.map(({ label, detail, recommended }) => ({
    label: label.trim(), detail: typeof detail === 'string' ? detail.trim() : '', recommended: recommended === true,
  }));
  return new Set(trimmed.map(option => option.label)).size === trimmed.length ? trimmed : null;
}

const lastBlock = written => [...written.matchAll(BLOCK)].at(-1);

/** The JSON text of a message's question block: the last one, as `questionIn` reads it. */
export const questionBlock = text => lastBlock(`${text ?? ''}`)?.[1];

/** A bot's text without its question block and the question it asks, or null when it asks none. The last block is the
 *  question, so a quoted example above it does not hide the real one. A malformed block stays in the text, so the person
 *  sees it as code rather than losing it. */
export function questionIn(text) {
  const written = `${text ?? ''}`;
  const block = lastBlock(written);
  const asked = block ? parsedBlock(block[1]) : null;
  const options = optionsOf(asked);
  if (!options) return null;
  return { text: written.replace(block[0], '').trim(), question: { multiple: asked.multiple === true, options, purpose: policyOf(asked.purpose), scope: asked.scope, for: asked.for } };
}
