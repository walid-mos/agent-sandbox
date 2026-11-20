export const CODEX_CONTRACT = 'CODEX_TARGETED_V1';
export const CODEX_POTS = Object.freeze(['accor', 'mastermind', 'nextnode', 'personal']);
export const refuseCodex = reason => new Error(`${CODEX_CONTRACT}: ${reason}, refused. Reconcile privately before another operation.`);
