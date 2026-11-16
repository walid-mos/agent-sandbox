export const groupModel = group => `magpie/${group}`;
export const ROUTER_MODEL = groupModel('group/router');
// This group skips the router for the strongest model, so a worker runs on it only when the person asked for it.
export const MAX_MODEL = groupModel('group/max');
