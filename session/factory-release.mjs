const APPROVED = new Set(['PASS', 'PASS+NOTES']);
const COMMIT_ID = /^[a-f0-9]{40}$/;

export function releaseRequest(record, { repository, ref, git }) {
  const { repository: reviewedRepository, number, generation, base, head, mergeBase, checks, verdict } = record;
  if (reviewedRepository !== repository || `refs/heads/${base}` !== ref || !APPROVED.has(verdict)
      || !Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(generation) || generation < 0
      || !COMMIT_ID.test(head) || !COMMIT_ID.test(mergeBase) || !checks?.length || !checks.every(check => check.isPassed === true)) {
    throw new Error('factory: publication needs the approved review record for the configured repository and ref.');
  }
  return { repository, number, generation, ref, base: mergeBase, head, tree: git.tree(head) };
}

function verifyReceipt(release, request, git) {
  if (!COMMIT_ID.test(release?.commit) || Object.keys(release.request ?? {}).length !== Object.keys(request).length
      || Object.entries(request).some(([key, value]) => release.request[key] !== value)) {
    throw new Error('factory: signer receipt does not identify the approved release.');
  }
  if (git.store(release) !== release.commit) throw new Error('factory: signed object does not match the signer receipt.');
  git.requireCandidate(release.commit, request);
}

function requireCheckedTip(tip, { base, ref }) {
  if (tip !== base) throw new Error(`factory: ${ref} is at ${tip}, expected checked base ${base}. Publication stopped.`);
}

export function publishReviewedRelease(record, save, authority) {
  const { git, requireReady, sign } = authority;
  if (!['judged', 'signed'].includes(record.stage)) throw new Error('factory: publication needs a judged or signed review.');
  const request = releaseRequest(record, authority);
  const tip = git.tip(request.ref);
  let signed = record;
  if (record.stage === 'judged') {
    requireCheckedTip(tip, request);
    requireReady(record, request);
    const release = sign(request);
    verifyReceipt(release, request, git);
    signed = save({ ...record, stage: 'signed', release });
  } else {
    verifyReceipt(signed.release, request, git);
  }
  const { commit } = signed.release;
  if (tip !== commit) {
    requireCheckedTip(tip, request);
    requireReady(signed, request);
    git.publish(commit, request);
    if (git.tip(request.ref) !== commit) throw new Error('factory: publication could not confirm the signed commit as the remote tip.');
  }
  git.requireReviewedHead(commit, request.head);
  return save({ ...signed, stage: 'published' });
}
