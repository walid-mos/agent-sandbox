import { CODEX_CONTRACT, CODEX_POTS, refuseCodex } from './codex-contract-names.mjs';
import { requireArray, requireFields, requireObject, requirePastDate, requireString } from './codex-validation.mjs';
import { readPrivateJson } from './router-configuration.mjs';
import { sha256 } from './codex-review.mjs';

const OWNER_HOLD_MS = 300_000;

function requireFreshHold(hold, pot, digest, now) {
  const reason = 'fresh owner reconciliation hold absent or revoked';
  requireFields({ contract: CODEX_CONTRACT, scopeSha256: digest, pot, state: 'HELD' }, hold, reason);
  requireArray(hold.originalUnfinishedSessions, reason);
  hold.originalUnfinishedSessions.forEach(id => requireString(id, reason));
  const at = requirePastDate(hold.at, now, reason);
  if (now - at > OWNER_HOLD_MS) throw refuseCodex(reason);
}

export function requireOwnerHolds(review) {
  requireObject(review.scope.ownerHoldPaths, 'fresh owner hold paths absent');
  const digest = sha256(JSON.stringify(review.scope));
  const now = Date.now();
  for (const pot of CODEX_POTS) requireFreshHold(readPrivateJson(review.scope.ownerHoldPaths[pot]), pot, digest, now);
}
