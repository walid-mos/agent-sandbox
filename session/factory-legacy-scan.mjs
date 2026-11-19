import { isLandingPull, requireLandingAuthority } from './factory-authority.mjs';
import { probe, runLegacyChecks } from './factory-checks.mjs';
import { draftPulls, FACTORY_TOPIC, readyPulls, watchedRepositories } from './factory-github.mjs';
import { branchTip, mergeBase, refreshMirror } from './factory-mirror.mjs';
import { logDirectory, pullUrl, readRecord, recordedHeads, withRecord } from './factory-records.mjs';
import { hasChecks } from './factory-repositories.mjs';
import { handToFactory, reportToPrincipal } from './factory-reports.mjs';
import { logScanFailure, scanStaleDrafts } from './factory-scan.mjs';

const CHECKS_MISSING = 'checks-missing';
const HELD = 'held';
const DECIDABLE = new Set(['MERGEABLE', 'CONFLICTING']);

function isNew(record, isChecked) {
  if (!record || record.stage === HELD) return true;
  return isChecked && record.stage === CHECKS_MISSING;
}

function nextGeneration(record) {
  const generation = record?.generation ?? 0;
  return record?.stage === HELD ? generation + 1 : generation;
}

function newHead(pull, isChecked) {
  if (!DECIDABLE.has(pull.mergeable)) return undefined;
  if (isLandingPull(pull)) requireLandingAuthority(pull.repository);
  const record = readRecord(pull);
  if (isNew(record, isChecked)) return { ...pull, generation: nextGeneration(record) };
}

function newHeads(repository, isChecked) {
  return readyPulls(repository)
    .map(pull => ({ repository, number: pull.number, head: pull.headRefOid, base: pull.baseRefName, branch: pull.headRefName, mergeable: pull.mergeable }))
    .map(pull => newHead(pull, isChecked)).filter(Boolean);
}

function hold(record) {
  if (!record || record.stage === HELD) return;
  withRecord(record, (current, save) => {
    if (current && current.stage !== HELD && !current.squashPublication) save({ ...current, stage: HELD });
  });
}

function holdDrafts(repository) {
  for (const pull of draftPulls(repository)) hold(readRecord({ repository, number: pull.number, head: pull.headRefOid }));
}

function holdUnwatched(repositories) {
  const watched = new Set(repositories);
  for (const record of recordedHeads()) {
    if (!watched.has(record.repository)) hold(record);
  }
}

function reportMissingChecks({ mergeable, ...pull }) {
  const text = `PR factory cannot check ${pullUrl(pull)} at head ${pull.head}: ${pull.repository} has the ${FACTORY_TOPIC} topic, and session/factory-repositories.json in agent-sandbox defines no checks for it. Nothing was checked, judged or merged. Once its checks are defined there, the next scan takes this head.`;
  return reportToPrincipal({ ...pull, stage: CHECKS_MISSING }, text);
}

function check(pull) {
  const base = mergeBase(pull.repository, branchTip(pull.repository, pull.base), pull.head);
  const checks = runLegacyChecks(pull, base, logDirectory(pull));
  const record = { ...pull, mergeBase: base, checks };
  const failed = checks.find(result => !result.isPassed);
  if (!failed) return handToFactory({ ...record, stage: 'checked' });
  return reportToPrincipal({ ...record, stage: 'checks-failed' }, `PR factory stopped ${pullUrl(pull)} at head ${pull.head}: its ${failed.name} check failed. The log is ${failed.log}. The pull request stays open and unmerged until a new head passes.`);
}

function handle({ mergeable, ...pull }) {
  if (mergeable === 'CONFLICTING') return handToFactory({ ...pull, stage: 'conflict' });
  return check(pull);
}

function handleLogged(pull, step) {
  try {
    const record = step(pull);
    process.stdout.write(`factory: ${pullUrl(pull)} at ${pull.head}: ${record.stage}\n`);
  } catch (error) {
    logScanFailure(`${pullUrl(pull)} at ${pull.head}`, error);
  }
}

function scanReadyPulls(repositories) {
  holdUnwatched(repositories);
  const { checked = [], unchecked = [] } = Object.groupBy(repositories, repository => (hasChecks(repository) ? 'checked' : 'unchecked'));
  for (const pull of unchecked.flatMap(repository => newHeads(repository, false))) handleLogged(pull, reportMissingChecks);
  for (const repository of checked) holdDrafts(repository);
  runPending(checked.flatMap(repository => newHeads(repository, true)));
}

function runPending(pending) {
  if (pending.length === 0) return;
  process.stdout.write(`${probe()}\n`);
  for (const repository of new Set(pending.map(pull => pull.repository))) refreshMirror(repository);
  for (const pull of pending) handleLogged(pull, handle);
}

export function scanLegacy() {
  const repositories = watchedRepositories();
  scanReadyPulls(repositories);
  scanStaleDrafts(repositories);
}
