export const GROUP_PREFIX = 'group/';
export const groupModel = group => `magpie/${group}`;
const ROUTER_GROUP = `${GROUP_PREFIX}router`;
export const ROUTER_MODEL = groupModel(ROUTER_GROUP);
// This group skips the router for the strongest model, so a worker runs on it only when the person asked for it.
const MAX_GROUP = `${GROUP_PREFIX}max`;
export const MAX_MODEL = groupModel(MAX_GROUP);
export const DEFAULT_GROUPS = [ROUTER_GROUP, MAX_GROUP];
