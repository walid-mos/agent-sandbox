export const groupModel = group => `magpie/${group}`;
export const ROUTER_GROUP = 'group/router';
export const ROUTER_MODEL = groupModel(ROUTER_GROUP);
// This group skips the router for the strongest model, so a worker runs on it only when the person asked for it.
export const MAX_GROUP = 'group/max';
export const MAX_MODEL = groupModel(MAX_GROUP);
