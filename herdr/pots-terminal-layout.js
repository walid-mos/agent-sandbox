export const DRAWER = "pots-terminal-drawer";
const SESSIONS = "pots-terminal-sessions";
export const TERMINAL_MOD = "pots-terminals";
const WORKSPACE = "pots-terminal-workspace";
const EMPTY = "pots-terminals-empty";
const HEADER_PX = 34;
const DRAWER_PX = 480;

function findWhere(tree, predicate) {
  if (tree && predicate(tree)) return tree;
  for (const child of tree?.children ?? []) {
    const found = findWhere(child, predicate);
    if (found) return found;
  }
}

export const findNode = (tree, id) => findWhere(tree, node => node.id === id);

function transform(tree, predicate, replace) {
  if (predicate(tree)) return replace(tree);
  if (!tree.children) return tree;
  return { ...tree, children: tree.children.map(child => transform(child, predicate, replace)) };
}

const block = (id, content) => ({ id, type: "block", content });
const header = (id, props) => ({ ...block(id, { mod: TERMINAL_MOD, props }), size: { px: HEADER_PX } });
const empty = () => block(EMPTY, { mod: TERMINAL_MOD, props: { empty: true } });
const sessionAddress = session => session.children?.find(child => child.content?.props?.terminal)?.content.props.terminal;

export function withDrawer(tree) {
  if (findNode(tree, DRAWER)) return tree;
  const pots = findWhere(tree, node => node.content?.mod === "pots");
  if (!pots) return tree;
  return transform(tree, node => node === pots, node => {
    const { size, ...conversation } = node;
    return {
      id: WORKSPACE, type: "row", size, divider: { width: 1, color: "border" },
      children: [
        {
          id: DRAWER, type: "column", hidden: true, size: { px: DRAWER_PX }, min: 240,
          children: [header(`${DRAWER}-header`, {}), { id: SESSIONS, type: "column", divider: { width: 1, color: "border" }, children: [empty()] }],
        },
        conversation,
      ],
    };
  });
}

export function withSession(tree, address) {
  if (sessionAddresses(tree).includes(address)) return tree;
  return transform(tree, node => node.id === SESSIONS, node => ({
    ...node,
    children: [...node.children.filter(child => child.id !== EMPTY), {
      id: `pots-session-${address}`, type: "column", size: { weight: 1 }, min: 100,
      children: [header(`pots-session-header-${address}`, { terminal: address }), block(`pots-shell-${address}`, { terminal: address })],
    }],
  }));
}

export const sessionAddresses = tree => (findNode(tree, SESSIONS)?.children ?? []).map(sessionAddress).filter(Boolean);

export function withoutSession(tree, address) {
  return transform(tree, node => node.id === SESSIONS, node => {
    const children = node.children.filter(session => sessionAddress(session) !== address);
    return { ...node, children: children.length ? children : [empty()] };
  });
}
