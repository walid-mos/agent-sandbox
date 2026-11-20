import { randomUUID } from 'node:crypto';
import { isLandingPull, requireLandingAuthority } from './factory-authority.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireCheckRevision } from './factory-execution.mjs';
import { comment, commentAuthor, hasComment, pullFacts, requireActionable, squashMerge } from './factory-github.mjs';
import { isDurableFactory } from './factory-mode.mjs';
import { reviewFacts, startPublication } from './factory-publication.mjs';
import { logDirectory, PULL_ARGUMENT_COUNT, pullArguments, requireRecord, usesSharedRecord, withRecord, writeRecord } from './factory-records.mjs';
import { pullUrl } from './github-url.mjs';
import { deliverWakes, queueReport, reportToPrincipal } from './factory-reports.mjs';
import { reviewId } from './factory-review.mjs';

const VERDICTS = ['PASS', 'PASS+NOTES', 'FAIL'];
const MERGED = 'MERGED';

function verdictBody(record, decision, notes) {
  const checks = record.checks.map(result => `${result.name} passed`).join(', ');
  return [`**PR factory verdict: ${decision}** for ${record.head}`, notes, `Checks on this commit, in a container without credentials: ${checks}.`]
    .filter(Boolean).join('\n\n');
}

function writeVerdictBody(record, body) {
  const directory = logDirectory(record);
  mkdirSync(directory, { recursive: true });
  const bodyFile = join(directory, 'verdict.md');
  writeFileSync(bodyFile, `${body}\n`);
  return bodyFile;
}

function postVerdict(record, decision, notes, save) {
  comment(record, writeVerdictBody(record, verdictBody(record, decision, notes)));
  return save({ ...record, stage: 'judged', verdict: decision, notes });
}

function confirmLandingComment(record, decision, notes, save) {
  const previous = record.verdictDelivery;
  const marker = previous?.marker ?? randomUUID();
  const body = `${verdictBody(record, decision, notes)}\n\n<!-- factory-verdict:${reviewId(record)}:${marker} -->`;
  if (previous?.body !== undefined && previous.body !== body) throw new Error('factory: retry the saved verdict and notes');
  if (previous?.isConfirmed) return record;
  const delivery = previous ?? { marker, body, author: commentAuthor(record) };
  if (previous) {
    if (!hasComment(record, delivery.author, body)) throw new Error('factory: saved verdict comment is unconfirmed');
  } else {
    save({ ...record, verdictDelivery: delivery });
    comment(record, writeVerdictBody(record, body));
  }
  return save({ ...record, verdictDelivery: { ...delivery, isConfirmed: true } });
}

function signedVerdict(record, decision, notes) {
  requireLandingAuthority(record.repository);
  const outcome = withRecord(record, (current, save) => {
    if (current?.generation !== record.generation || current.stage !== 'checked') throw new Error('factory: checked review changed');
    reviewFacts(current);
    requireCheckRevision(current);
    const confirmed = confirmLandingComment(current, decision, notes, save);
    const judged = { ...confirmed, stage: 'judged', verdict: decision, notes };
    if (decision === 'FAIL') return save(queueReport({ ...judged, stage: 'failed' }, `PR factory judged ${pullUrl(judged)} FAIL: ${notes}`));
    if (judged.recoveryOf) return save(judged);
    return startPublication(judged, save);
  });
  return deliverWakes(outcome);
}

function land(record, report) {
  if (isDurableFactory) {
    requireActionable(record);
    requireCheckRevision(record);
  }
  const merge = squashMerge(record);
  const after = pullFacts(record);
  if (after.state !== MERGED) {
    return report({ ...record, stage: 'refused', mergeOutput: merge.output },
      `PR factory could not merge ${pullUrl(record)} at head ${record.head} after its ${record.verdict} verdict. GitHub answered: ${merge.output || after.state}. The factory does not retry this head.`);
  }
  const mergeCommit = after.mergeCommit?.oid;
  return report({ ...record, stage: 'merged', mergeCommit },
    `PR factory merged ${pullUrl(record)} into ${after.baseRefName} as ${mergeCommit}, after a ${record.verdict} verdict on head ${record.head}.`);
}

function reportFailure(record, report) {
  return report({ ...record, stage: 'failed' }, `PR factory judged ${pullUrl(record)} FAIL at head ${record.head}, so it stays unmerged. The verdict says: ${record.notes}`);
}

function readNotes(decision, path) {
  const notes = path ? readFileSync(path, 'utf8').trim() : '';
  if (decision !== 'PASS' && !notes) throw new Error(`factory: ${decision} needs a notes file that says why.`);
  return notes;
}

function ordinaryVerdict(record, decision, notes, save, report) {
  requireActionable(record);
  if (isDurableFactory) requireCheckRevision(record);
  const judged = postVerdict(record, decision, notes, save);
  return decision === 'FAIL' ? reportFailure(judged, report) : land(judged, report);
}

function sharedOrdinaryVerdict(record, decision, notes) {
  const outcome = withRecord(record, (current, save) => {
    if (current?.generation !== record.generation || current.stage !== 'checked') throw new Error('factory: checked review changed');
    return ordinaryVerdict(current, decision, notes, save, (result, text) => save(queueReport(result, text)));
  });
  return deliverWakes(outcome);
}

function recordVerdict(record, decision, notes) {
  if (isLandingPull(record)) return signedVerdict(record, decision, notes);
  if (usesSharedRecord(record)) return sharedOrdinaryVerdict(record, decision, notes);
  return ordinaryVerdict(record, decision, notes, writeRecord, reportToPrincipal);
}

export function verdict(arguments_) {
  const pull = pullArguments(arguments_);
  const [decision, notesFile, ...extra] = arguments_.slice(PULL_ARGUMENT_COUNT);
  if (isDurableFactory && extra.length) throw new Error('factory: the verdict takes only a decision and optional notes file');
  if (!VERDICTS.includes(decision)) throw new Error(`factory: the verdict is one of ${VERDICTS.join(', ')}, got ${decision}`);
  const notes = readNotes(decision, notesFile);
  const record = requireRecord(pull, 'checked');
  requireLandingAuthority(record.repository);
  const outcome = recordVerdict(record, decision, notes);
  process.stdout.write(`factory: ${pullUrl(pull)} at ${pull.head}: ${outcome.stage}\n`);
}
