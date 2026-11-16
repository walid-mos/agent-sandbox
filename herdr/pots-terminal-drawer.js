import { hc, home, layout, machines, focused, terminals, run, shared, setShared, notify } from "herdr";
import { DRAWER, findNode, withDrawer, withSession, sessionAddresses, withoutSession } from "./pots-terminal-layout.js";
import { commitLayout } from "./pots-layout-file.js";

export const MACHINE = "pots.terminal.machine";
export const OPENING = "pots.terminal.opening";
const CLOSING = "pots.terminal.closing";
const FOCUS = "pots.terminal.focus";
const RECONCILE_MS = 2000;
const OWNER = "pots.drawer";
let lastFailure = null;
const isFinishedTerminal = terminal => terminal.state === "finished" && terminal.reason !== "holder_lost";
function reportFailure(title, error) {
  const key = `${title}: ${error.message}`;
  if (key === lastFailure) return;
  lastFailure = key;
  notify({ title, body: error.message, level: "error" });
}

export const machineLabel = machine => machine ?? "This computer";

export const chosenMachine = () => shared(MACHINE) ?? null;
export function isDrawerOpen() {
  const drawer = findNode(layout(), DRAWER);
  return Boolean(drawer && !drawer.hidden);
}
export const terminalMachine = address => address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : null;
export const isMachineReady = name => machines().some(machine => machine.name === name && machine.layout === "ready");

const closingAddresses = () => shared(CLOSING) ?? [];
export const isTerminalClosing = address => closingAddresses().includes(address);

export function endTerminal(address, cx) {
  if (isTerminalClosing(address)) return;
  setShared(CLOSING, [...closingAddresses(), address]);
  cx.spawn(async cx => {
    try {
      const result = await hc(["kill", address]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not end terminal ${address}. Try End again.`);
      await commitLayout(tree => withoutSession(tree, address), tree => !sessionAddresses(tree).includes(address), cx);
      const next = sessionAddresses(layout())[0];
      if (next) run("pane.focus", { terminal: next });
      else run("pots.focus");
    }
    catch (error) {
      setShared(CLOSING, closingAddresses().filter(candidate => candidate !== address));
      reportFailure("Terminal could not end", error);
    }
  });
}

export class TerminalDrawer {
  constructor(cx) {
    this.isOpening = false;
    this.isReconciling = false;
    this.shouldReveal = false;
    this.checking = new Set();
    setShared(OPENING, false);
    setShared(CLOSING, []);
    cx.timer.every(RECONCILE_MS, cx => this.reconcile(cx));
  }

  focus(addresses = sessionAddresses(layout())) {
    const last = shared(FOCUS);
    const address = addresses.includes(last) ? last : addresses[0];
    if (address) run("pane.focus", { terminal: address });
  }

  toggle(cx) {
    if (!isDrawerOpen()) return this.open(cx, { isNew: false });
    this.shouldReveal = false;
    const address = focused()?.terminal;
    if (sessionAddresses(layout()).includes(address)) setShared(FOCUS, address);
    run("layout.hide", { id: DRAWER });
    run("pots.focus");
  }

  next() {
    const addresses = sessionAddresses(layout());
    if (!addresses.length) return;
    const index = addresses.indexOf(focused()?.terminal);
    run("layout.show", { id: DRAWER });
    run("pane.focus", { terminal: addresses[(index + 1) % addresses.length] });
  }

  open(cx, { isNew = true } = {}) {
    if (this.isOpening) return;
    this.isOpening = true;
    this.shouldReveal = true;
    setShared(OPENING, true);
    cx.spawn(async cx => {
      try { await this.reveal(cx, isNew); }
      catch (error) { reportFailure("Terminal could not open", error); }
      finally { this.isOpening = false; setShared(OPENING, false); cx.notify(); }
    });
  }

  async reveal(cx, isNew) {
    await commitLayout(withDrawer, tree => Boolean(findNode(tree, DRAWER)), cx);
    if (!findNode(layout(), DRAWER)) throw new Error("Terminal needs a Pots block in this layout.");
    run("layout.show", { id: DRAWER });
    const addresses = sessionAddresses(layout());
    if (addresses.length && !isNew) return this.focus(addresses);
    await this.create(cx);
  }

  async create(cx) {
    const machine = chosenMachine();
    if (!isMachineReady(machine)) {
      throw new Error(`${machineLabel(machine)} is unavailable. Connect it in Herdr's Machines settings or choose another computer.`);
    }
    const owner = shared("layout");
    const current = focused();
    const folder = current?.terminal && terminalMachine(current.terminal) === machine ? current.cwd : null;
    const args = ["run", "--json", "--bg", "--keep", "--no-parent", "--label", `${OWNER}=${owner}`];
    if (machine) args.push("--on", machine);
    if (folder || !machine) args.push("--cwd", folder || home());
    const result = await hc(args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not start a shell on ${machineLabel(machine)}.`);
    const address = JSON.parse(result.stdout).address;
    if (typeof address !== "string" || !address) throw new Error("Herdr started no addressable terminal. Check hc ls before trying again.");
    setShared(FOCUS, address);
    if (shared("layout") !== owner) return;
    await commitLayout(tree => withSession(tree, address), tree => sessionAddresses(tree).includes(address), cx);
    lastFailure = null;
    if (!this.shouldReveal) return;
    run("layout.show", { id: DRAWER });
    run("pane.focus", { terminal: address });
  }

  async checkFinished(address, cx) {
    if (this.checking.has(address)) return;
    this.checking.add(address);
    const owner = shared("layout");
    try {
      const result = await hc(["get", address, "--json"]);
      if (result.code !== 0 || shared("layout") !== owner) return;
      if (!isFinishedTerminal(JSON.parse(result.stdout))) return;
      await commitLayout(tree => withoutSession(tree, address), tree => !sessionAddresses(tree).includes(address), cx);
    }
    catch { return; }
    finally { this.checking.delete(address); }
  }

  reconcile(cx) {
    const tree = layout();
    if (this.isOpening || this.isReconciling || !findNode(tree, DRAWER)) return;
    const live = new Map(terminals().map(terminal => [terminal.address, terminal]));
    const owner = shared("layout");
    const closing = closingAddresses();
    const owned = [...live.values()].filter(terminal => terminal.labels?.[OWNER] === owner && !closing.includes(terminal.address));
    const addresses = sessionAddresses(tree);
    const added = owned.filter(terminal => terminal.state === "live" && !addresses.includes(terminal.address)).map(terminal => terminal.address);
    const removed = owned.filter(terminal => isFinishedTerminal(terminal) && addresses.includes(terminal.address)).map(terminal => terminal.address);
    for (const address of addresses) {
      if (!live.has(address) && isMachineReady(terminalMachine(address))) cx.spawn(cx => this.checkFinished(address, cx));
    }
    if (added.length || removed.length) this.sync(cx, added, removed);
    const pending = closing.filter(address => live.get(address)?.state === "live");
    if (pending.length !== closing.length) setShared(CLOSING, pending);
  }

  sync(cx, added, removed) {
    this.isReconciling = true;
    cx.spawn(async cx => {
      try {
        await commitLayout(
          tree => removed.reduce(withoutSession, added.reduce(withSession, tree)),
          tree => added.every(address => sessionAddresses(tree).includes(address)) && removed.every(address => !sessionAddresses(tree).includes(address)),
          cx,
        );
      }
      catch (error) { reportFailure("Terminals could not be restored", error); }
      finally { this.isReconciling = false; }
    });
  }
}
