import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE_FILES = [
  join('.github', 'pull_request_template.md'), join('.github', 'PULL_REQUEST_TEMPLATE.md'),
  join('docs', 'pull_request_template.md'), 'pull_request_template.md',
];
const TEMPLATE_DIRECTORY = join('.github', 'PULL_REQUEST_TEMPLATE');
const COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*$/;
const PLACEHOLDER = /^(?:tbd|t\.b\.d\.?|todo|to do|fixme|wip|n\/?a|none|nothing|same as (?:the )?title|describe (?:the|this) change\.?|see (?:the )?(?:diff|commits?)\.?|\.{3,}|…)$/i;
const WORD = /[\p{L}\p{N}]+/gu;
// A body that carries no sentence of its own describes nothing, whatever its headings say.
const MINIMUM_PROSE_WORDS = 6;

const withoutComments = text => `${text ?? ''}`.replace(COMMENT, '');

const bodyLine = line => line.replace(/^[\s>*+-]*/, '').trim();

function templateText(checkout) {
  if (!checkout) return undefined;
  const candidates = TEMPLATE_FILES.map(file => join(checkout, file));
  const directory = join(checkout, TEMPLATE_DIRECTORY);
  if (existsSync(directory)) {
    candidates.push(...readdirSync(directory).filter(name => name.endsWith('.md')).sort().map(name => join(directory, name)));
  }
  const found = candidates.find(candidate => existsSync(candidate));
  return found ? withoutComments(readFileSync(found, 'utf8')) : undefined;
}

function headings(text) {
  return text.split('\n').flatMap(line => HEADING.exec(line)?.[1] ?? []);
}

function proseWords(text) {
  return text.split('\n').map(bodyLine)
    .filter(line => line && !HEADING.test(line) && !PLACEHOLDER.test(line))
    .flatMap(line => line.match(WORD) ?? []);
}

/** Returns the body unchanged, or throws when it is a placeholder or skips a section of the repository's template. */
export function requireChangeBody(description, checkout) {
  const text = withoutComments(description);
  if (proseWords(text).length < MINIMUM_PROSE_WORDS) {
    throw new Error('dispatch: --description must describe the real change in a sentence or more. A placeholder, a bare heading or an empty body is refused.');
  }
  const written = headings(text).map(heading => heading.toLowerCase());
  const missing = templateSections(checkout).filter(heading => !written.includes(heading.toLowerCase()));
  if (missing.length) throw new Error(`dispatch: --description must follow the repository's pull request template. Add the missing sections: ${missing.join(', ')}.`);
  return description;
}

/** The description a worker recorded at start, which every deferred PR path must carry. */
export function requireRecordedBody(worker) {
  if (worker.description) return requireChangeBody(worker.description, worker.worktree);
  throw new Error('dispatch: this worker recorded no public description, and a pull request is never opened with an empty body. Start the work again with --description, then open the pull request, or write the body by hand first.');
}

export function templateSections(checkout) {
  return headings(templateText(checkout) ?? '');
}
