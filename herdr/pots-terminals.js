import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, props, run, terminals } from "herdr";
import { MACHINE, OPENING, chosenMachine, terminalMachine, isDrawerOpen, endTerminal, isTerminalClosing } from "./pots-terminal-drawer.js";
import { isMachineReady, machineLabel } from "./pots-machines.js";
import { barButton } from "./pots-icons.js";
import { AGENT_PICKER, NewAgent } from "./pots-new-agent.js";
import { MachinePicker, pickMachine } from "./pots-machine-picker.js";

const TERMINAL_PICKER = {
  key: "terminal", title: "Terminal on…", label: "Terminal computer", chosen: chosenMachine,
  choose: machine => { setShared(MACHINE, machine); run("pots.terminal-new"); },
};
const PICKERS = Object.fromEntries([TERMINAL_PICKER, AGENT_PICKER].map(purpose => [purpose.key, purpose]));

export const terminalToggle = () => barButton({
  id: "pots-terminal-toggle", text: "Terminal", iconName: "terminal", isSelected: isDrawerOpen(), action: () => run("pots.terminal"),
});

export const pickTerminalMachine = () => pickMachine(TERMINAL_PICKER);

export default class TerminalControls extends View {
  init(_props, cx) {
    const { agents, picker } = props() ?? {};
    this.popup = agents ? new NewAgent(agents.machine, cx) : picker ? new MachinePicker(PICKERS[picker], cx) : null;
    this.isConfirming = false;
  }

  session(address) {
    const terminal = terminals().find(terminal => terminal.address === address);
    const colors = theme();
    const title = `${machineLabel(terminalMachine(address))} · ${terminal?.cwd || address}`;
    const isClosing = isTerminalClosing(address);
    return this.bar().child(div().flex_1().min_w(0).truncate().tooltip(title).text_size(12).text_color(colors.muted).child(title))
      .when(this.isConfirming, element => element
        .child(barButton({ id: "terminal-cancel-end", text: "Cancel", action: (_event, cx) => { this.isConfirming = false; cx.notify(); } })))
      .child(barButton({ id: "terminal-end", text: isClosing ? "Ending…" : this.isConfirming ? "End terminal?" : "End", isDisabled: isClosing, action: (_event, cx) => {
        if (this.isConfirming) endTerminal(address, cx);
        else { this.isConfirming = true; cx.notify(); }
      } }));
  }

  bar() {
    const colors = theme();
    return h_flex().size_full().min_w(0).gap(4).px(6).items_center().bg(colors.chrome).border_b(1).border_color(colors.border);
  }

  render() {
    if (this.popup) return this.popup.render();
    if (props()?.terminal) return this.session(props().terminal);
    if (props()?.empty) return v_flex().size_full().p(16).gap(8).justify_center().text_size(12).text_color(theme().muted)
      .child("Your shells stay here when you hide this pane.")
      .child("Press New, or choose a computer above, to open a terminal.");
    const machine = chosenMachine();
    const isReady = isMachineReady(machine);
    const isOpening = Boolean(shared(OPENING));
    return this.bar()
      .child(barButton({ id: "terminal-machine-picker", text: `${machineLabel(machine)}…`, iconName: "terminal", action: pickTerminalMachine }))
      .child(barButton({ id: "terminal-new", text: isOpening ? "Opening…" : "New", isDisabled: !isReady || isOpening, action: () => run("pots.terminal-new") }))
      .child(div().flex_1())
      .child(barButton({ id: "terminal-hide", text: "Hide", action: () => run("pots.terminal") }));
  }
}
