import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { beginSquashPublication, finishSquashPublication } from '../session/factory-squash-publication.mjs';

function disposableMerge({ remote, proof }, tree = proof.tree) {
  const { ref, base, head, repository, number } = proof;
  const origin = (...args) => execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' }).trim();
  const squash = origin('commit-tree', tree, '-p', base, '-m', `native squash #${number}`);
  origin('update-ref', ref, squash, base);
  origin('update-server-info');
  return { state: 'MERGED', repository, number, head, ref, squash };
}

function rejectUnboundReadbacks(finish, facts, authority) {
  for (const mismatch of [{ state: 'OPEN' }, { head: facts.squash }, { ref: 'refs/heads/wrong' },
    { number: facts.number + 1 }, { repository: 'other/repository' }]) {
    assert.throws(() => finish({ ...authority, readMerge: () => ({ ...facts, ...mismatch }) }), /merge readback/);
  }
}

function assertTagContract({ clone, root, proof }, { squash, tag }) {
  const decoded = execFileSync('git', ['-C', clone, 'cat-file', 'tag', tag], { encoding: 'utf8' });
  assert.equal(decoded.split('\n')[0], `object ${squash}`);
  execFileSync('git', ['-C', clone, 'verify-tag', tag], { env: { ...process.env, GNUPGHOME: `${root}/factory` } });
  const request = JSON.parse(decoded.split('\n\n')[2].split('\n-----BEGIN PGP SIGNATURE-----')[0]);
  assert.deepEqual(request, { ...proof, squash });
}

export async function runDurableSquash(context) {
  const { root, sharedRecord, checked, proof, policy, source, git, requireReady, withRecord, readRecord } = context;
  const { queueReport, deliverWakes } = await import(pathToFileURL(`${sharedRecord}/factory-reports.mjs`));
  let signCount = 0;
  const sign = request => {
    signCount += 1;
    return JSON.parse(execFileSync('python3', ['-B', policy, '--sign-squash', source], { input: JSON.stringify(request) }));
  };
  const authority = { repository: proof.repository, ref: proof.ref, git, requireReady, sign, queueReport };
  const begin = () => withRecord(checked, (record, save) => beginSquashPublication(record, save, authority));
  const finish = adapters => withRecord(checked, (record, save) => finishSquashPublication(record, save, adapters));
  assert.throws(() => finish(authority), /no bound native squash/);
  begin();
  assert.deepEqual(readRecord(checked).squashPublication.request, proof);
  assert.throws(begin, /needs a judged review/);
  const raced = disposableMerge(context, git.tree(proof.base));
  assert.throws(() => finish({ ...authority, readMerge: () => raced }), /checked tree/);
  assert.equal(signCount, 0);
  execFileSync('git', ['--git-dir', context.remote, 'update-ref', proof.ref, proof.base, raced.squash]);
  const facts = disposableMerge(context);
  assertRestrictedSigner(context, facts);
  rejectUnboundReadbacks(finish, facts, authority);
  assert.equal(readRecord(checked).stage, 'squash-pending');
  const readback = { ...authority, readMerge: () => facts };
  assert.throws(() => finish({ ...readback, readMerge: () => ({ ...facts, squash: proof.head }) }), /outside the target first-parent history/);
  assert.equal(signCount, 0);
  const loseSignature = request => { sign(request); throw new Error('fixture lost the signature response'); };
  assert.throws(() => finish({ ...readback, sign: loseSignature }), /lost the signature response/);
  const beforeRetry = readRecord(checked);
  assert.equal(beforeRetry.stage, 'squash-observed');
  const signerReceipt = `${root}/state/squash-release.json`;
  assert.equal(statSync(signerReceipt).mode & 0o777, 0o600);
  const savedTag = JSON.parse(readFileSync(signerReceipt, 'utf8')).tag;
  assertPublicationRetry({ ...context, readback, savedTag, finish, deliverWakes, facts });
  assert.equal(signCount, 2);
}

function assertRestrictedSigner({ policy, source, proof, root }, { squash }) {
  const receipt = `${root}/state/squash-release.json`;
  for (const mismatch of [{ payload: 'caller message' }, { ref: 'refs/heads/wrong' }, { origin: 'other' },
    { tree: proof.base }, { head: squash }, { squash: proof.head }]) {
    assert.throws(() => execFileSync('python3', ['-B', policy, '--sign-squash', source], {
      input: JSON.stringify({ ...proof, squash, ...mismatch }), stdio: ['pipe', 'pipe', 'pipe'],
    }), { status: 1 });
    assert.throws(() => statSync(receipt), { code: 'ENOENT' });
  }
}

function assertPublicationRetry({ root, clone, proof, remote, checked, git, readRecord, readback, savedTag, finish, deliverWakes, facts }) {
  const losePublication = { ...git, publishSquashEvidence(tag, request) {
    assert.equal(tag, savedTag);
    git.publishSquashEvidence(tag, request);
    throw new Error('fixture stopped after remote publication');
  } };
  assert.throws(() => finish({ ...readback, git: losePublication }), /stopped after remote publication/);
  const signed = readRecord(checked);
  assert.equal(signed.stage, 'squash-signed');
  assert.equal(signed.pendingWakes, undefined);
  assertTagContract({ root, clone, proof }, { squash: facts.squash, tag: savedTag });
  const locator = `refs/tags/factory-reviewed/${facts.squash}`;
  const setRef = (...args) => execFileSync('git', ['--git-dir', remote, 'update-ref', ...args]);
  setRef(locator, proof.base, proof.head);
  const retry = { ...readback, sign: () => assert.fail('saved release was signed again') };
  assert.throws(() => finish(retry), /partial or conflicting/);
  setRef(locator, proof.head, proof.base);
  writeFileSync(`${remote}/hooks/pre-receive`, '#!/bin/sh\nexit 1\n', { mode: 0o700, flag: 'wx' });
  const published = finish(retry);
  assert.equal(published.mergeCommit, facts.squash);
  assert.equal(git.tip(proof.ref), facts.squash);
  assert.equal(published.pendingWakes.length, 1);
  assert.deepEqual(finish(retry), published);
  assert.throws(() => deliverWakes(published), /lost the wake acknowledgement/);
  const pending = readRecord(checked);
  assert.deepEqual(pending.pendingWakes, published.pendingWakes);
  deliverWakes(pending);
  assert.equal(readRecord(checked).pendingWakes, undefined);
}
