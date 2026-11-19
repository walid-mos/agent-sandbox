import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLandingPull } from './factory-authority.mjs';
import { comment, commentAuthor, hasComment, pullFacts, squashMerge } from './factory-github.mjs';
import { reviewFacts, startPublication } from './factory-publication.mjs';
import { logDirectory, withRecord } from './factory-records.mjs';
import { pullUrl } from './github-url.mjs';
import { deliverWakes, queueReport } from './factory-reports.mjs';
import { requireReview } from './factory-review.mjs';

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

function verdictComment(record, review, decision, notes, save) {
  const body = verdictBody(record, decision, notes);
  if (!isLandingPull(record)) return comment(record, writeVerdictBody(record, body));
  const previous = record.verdictDelivery;
  const marker = previous?.marker ?? randomUUID();
  const markedBody = `${body}\n\n<!-- factory-verdict:${review}:${marker} -->`;
  if (previous && (previous.review !== review || previous.body !== markedBody)) {
    throw new Error('factory: retry the same bound verdict and notes as the saved attempt.');
  }
  if (previous?.isConfirmed) return;
  const delivery = previous ?? { review, marker, author: commentAuthor(record), body: markedBody };
  if (!previous) {
    const bodyFile = writeVerdictBody(record, markedBody);
    save({ ...record, verdictDelivery: delivery });
    comment(record, bodyFile);
  } else if (!hasComment(record, delivery.author, markedBody)) {
    // An absent comment does not prove GitHub rejected the POST.
    throw new Error('factory: the saved verdict comment is unconfirmed. Retry this bound verdict to check GitHub again.');
  }
  save({ ...record, verdictDelivery: { ...delivery, isConfirmed: true } });
}

function land(record) {
  const merge = squashMerge(record);
  const after = pullFacts(record);
  if (after.state !== MERGED) {
    return queueReport({ ...record, stage: 'refused', mergeOutput: merge.output },
      `PR factory could not merge ${pullUrl(record)} at head ${record.head} after its ${record.verdict} verdict. GitHub answered: ${merge.output || after.state}. The factory does not retry this head.`);
  }
  const mergeCommit = after.mergeCommit?.oid;
  return queueReport({ ...record, stage: 'merged', mergeCommit },
    `PR factory merged ${pullUrl(record)} into ${after.baseRefName} as ${mergeCommit}, after a ${record.verdict} verdict on head ${record.head}.`);
}

function reportFailure(record) {
  return queueReport({ ...record, stage: 'failed' }, `PR factory judged ${pullUrl(record)} FAIL at head ${record.head}, so it stays unmerged. The verdict says: ${record.notes}`);
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
  const record = requireReview(review);
  const outcome = withRecord(record, (_, save) => {
    const current = requireReview(review);
    reviewFacts(current);
    verdictComment(current, review, decision, notes, save);
    const { verdictDelivery, ...checked } = current;
    const judged = { ...checked, stage: 'judged', verdict: decision, notes };
    if (!current.recoveryOf && decision !== 'FAIL' && isLandingPull(judged)) return startPublication(judged, save);
    save(judged);
    if (current.recoveryOf && decision === 'FAIL') {
      return save(queueReport({ ...judged, stage: 'failed' }, `PR factory refused to certify squash ${current.head}: ${notes}`));
    }
    if (current.recoveryOf) return judged;
    if (decision === 'FAIL') return save(reportFailure(judged));
    return save(land(judged));
  });
  deliverWakes(outcome);
  process.stdout.write(`factory: ${pullUrl(outcome)} at ${outcome.head}: ${outcome.stage}\n`);
}
