import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comment, pullFacts, requireActionable, squashMerge } from './factory-github.mjs';
import { logDirectory, pullUrl, writeRecord } from './factory-records.mjs';
import { reportToPrincipal } from './factory-reports.mjs';
import { requireReview } from './factory-review.mjs';

const VERDICTS = ['PASS', 'PASS+NOTES', 'FAIL'];
const MERGED = 'MERGED';

function verdictBody(record, decision, notes) {
  const checks = record.checks.map(result => `${result.name} passed`).join(', ');
  return [`**PR factory verdict: ${decision}** for ${record.head}`, notes, `Checks on this commit, in a container without credentials: ${checks}.`]
    .filter(Boolean).join('\n\n');
}

function postVerdict(record, decision, notes) {
  const directory = logDirectory(record);
  mkdirSync(directory, { recursive: true });
  const bodyFile = join(directory, 'verdict.md');
  writeFileSync(bodyFile, `${verdictBody(record, decision, notes)}\n`);
  comment(record, bodyFile);
  return writeRecord({ ...record, stage: 'judged', verdict: decision, notes });
}

function land(record) {
  const merge = squashMerge(record);
  const after = pullFacts(record);
  if (after.state !== MERGED) {
    return reportToPrincipal({ ...record, stage: 'refused', mergeOutput: merge.output },
      `PR factory could not merge ${pullUrl(record)} at head ${record.head} after its ${record.verdict} verdict. GitHub answered: ${merge.output || after.state}. The factory does not retry this head.`);
  }
  const mergeCommit = after.mergeCommit?.oid;
  return reportToPrincipal({ ...record, stage: 'merged', mergeCommit },
    `PR factory merged ${pullUrl(record)} into ${after.baseRefName} as ${mergeCommit}, after a ${record.verdict} verdict on head ${record.head}.`);
}

function reportFailure(record) {
  return reportToPrincipal({ ...record, stage: 'failed' }, `PR factory judged ${pullUrl(record)} FAIL at head ${record.head}, so it stays unmerged. The verdict says: ${record.notes}`);
}

function readNotes(decision, notesFile) {
  const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : '';
  if (decision !== 'PASS' && !notes) throw new Error(`factory: ${decision} needs a notes file that says why.`);
  return notes;
}

export function verdict(review, [decision, notesFile, ...extra]) {
  if (extra.length > 0) throw new Error('factory: the bound verdict command takes only a decision and optional notes file.');
  if (!VERDICTS.includes(decision)) throw new Error(`factory: the verdict is one of ${VERDICTS.join(', ')}, got ${decision}`);
  const notes = readNotes(decision, notesFile);
  requireActionable(requireReview(review));
  const judged = postVerdict(requireReview(review), decision, notes);
  const outcome = decision === 'FAIL' ? reportFailure(judged) : land(judged);
  process.stdout.write(`factory: ${pullUrl(outcome)} at ${outcome.head}: ${outcome.stage}\n`);
}
