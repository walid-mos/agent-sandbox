import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comment, pullFacts, requireActionable, squashMerge } from './factory-github.mjs';
import { logDirectory, pullArguments, requireRecord, writeRecord } from './factory-records.mjs';
import { pullUrl } from './github-url.mjs';
import { reportToPrincipal } from './factory-reports.mjs';
import { signPublication } from './factory-publication.mjs';
import { isLandingPull, LANDING_BRANCH } from './factory-authority.mjs';

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
  const before = requireActionable(record);
  if (isLandingPull(record) && before.baseRefOid !== record.releaseBase) {
    throw new Error(`factory: ${LANDING_BRANCH} moved after the checks. A new checked head is required before merging.`);
  }
  const mergeOutput = squashMerge(record);
  const after = pullFacts(record);
  if (after.state !== MERGED) {
    return reportToPrincipal({ ...record, stage: 'refused', mergeOutput },
      `PR factory could not merge ${pullUrl(record)} at head ${record.head} after its ${record.verdict} verdict. GitHub answered: ${mergeOutput || after.state}. The factory does not retry this head.`);
  }
  return signPublication(record, after);
}

function reportFailure(record) {
  return reportToPrincipal({ ...record, stage: 'failed' }, `PR factory judged ${pullUrl(record)} FAIL at head ${record.head}, so it stays unmerged. The verdict says: ${record.notes}`);
}

export function verdict(arguments_) {
  const pull = pullArguments(arguments_);
  const [decision, notesFile] = arguments_.slice(3);
  if (!VERDICTS.includes(decision)) throw new Error(`factory: the verdict is one of ${VERDICTS.join(', ')}, got ${decision}`);
  const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : '';
  if (decision !== 'PASS' && !notes) throw new Error(`factory: ${decision} needs a notes file that says why.`);
  const record = requireRecord(pull, 'checked');
  requireActionable(pull);
  const judged = postVerdict(record, decision, notes);
  const outcome = decision === 'FAIL' ? reportFailure(judged) : land(judged);
  process.stdout.write(`factory: ${pullUrl(pull)} at ${pull.head}: ${outcome.stage}\n`);
}
