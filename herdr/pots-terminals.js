import { View, div } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { theme, machines, shared, setShared, props, run, openOverlay, closeOverlay, terminals } from "herdr";
import { MACHINE, OPENING, chosenMachine, terminalMachine, isDrawerOpen, isMachineReady, machineLabel, endTerminal, isTerminalClosing } from "./pots-terminal-drawer.js";
import { TERMINAL_MOD } from "./pots-terminal-layout.js";
import { icon } from "./pots-icons.js";
import { stopPress } from "./ui.js";
import { NewAgent } from "./pots-new-agent.js";
import { POPUP_MAX_PX, listBox, listPopup, popupHeight } from "./pots-list-box.js";

function terminalButton({ id, text, iconName, action, isDisabled = false, isSelected = false }) {
  const colors = theme();
  return Button.new(id).h(26).min_w(26).px(7).gap(5).flex_none().h_flex().items_center().justify_center().rounded(6)
    .text_size(12).text_color(isDisabled ? colors.dim : colors.foreground)
    .bg(isSelected ? colors.selected : colors.chrome).selected(isSelected).disabled(isDisabled)
    .accessibility_label(text).tooltip(text).cursor_pointer()
    .hover(style => style.bg(colors.hover)).focus(style => style.border(2).border_color(colors.accent))
    .on_mouse_down("left", stopPress).on_click(action)
    .when(Boolean(iconName), element => element.child(icon(iconName)))
    .child(text);
}

export const terminalToggle = () => terminalButton({
  id: "pots-terminal-toggle", text: "Terminal", iconName: "terminal", isSelected: isDrawerOpen(), action: () => run("pots.terminal"),
});

function pickMachine(purpose) {
  return openOverlay({
    mod: TERMINAL_MOD, kind: "popup", width: 300, height: popupHeight(machines().length),
    props: { picker: purpose },
  });
}

export const pickTerminalMachine = () => pickMachine("terminal");
export const pickAgentMachine = () => pickMachine("agent");
export const newAgentToggle = () => terminalButton({
  id: "pots-new-agent", text: "New agent…", action: pickAgentMachine,
});

export default class TerminalControls extends View {
  init(_props, cx) {
    if (Object.hasOwn(props() ?? {}, "agentMachine")) this.newAgent = new NewAgent(props().agentMachine, cx);
    this.isConfirming = false;
    this.selected = props()?.picker === "agent" ? 0 : Math.max(0, machines().findIndex(machine => machine.name === chosenMachine()));
    this.handle = cx.focus_handle();
    if (props()?.picker) this.handle.focus();
  }

  choose(machine) {
    if (!isMachineReady(machine.name)) return;
    closeOverlay(props().overlay);
    if (props().picker === "agent") {
      openOverlay({ mod: TERMINAL_MOD, kind: "popup", width: 320, height: POPUP_MAX_PX, props: { agentMachine: machine.name } });
      return;
    }
    setShared(MACHINE, machine.name);
    run("pots.terminal-new");
  }

  picker() {
    const choices = machines();
    const isAgent = props().picker === "agent";
    const chosen = isAgent ? undefined : chosenMachine();
    this.selected = Math.max(0, Math.min(this.selected, choices.length - 1));
    return listPopup({ id: "terminal-machines", title: isAgent ? "New agent on…" : "Terminal on…", message: choices.length ? "" : "No computers available. Open Machines settings." })
      .child(listBox({
        id: "terminal-machine-choices", label: isAgent ? "New agent computer" : "Terminal computer", handle: this.handle, selected: this.selected,
        options: choices.map((machine, index) => {
          const isReady = isMachineReady(machine.name);
          const isChosen = machine.name === chosen;
          return { id: `terminal-machine-${index}`, text: machineLabel(machine.name), detail: !isReady ? machine.layout : isChosen ? "Selected" : "", isEnabled: isReady, isSelected: isChosen };
        }),
        select: index => { this.selected = index; },
        choose: index => this.choose(choices[index]),
      }));
  }

  session(address) {
    const terminal = terminals().find(terminal => terminal.address === address);
    const colors = theme();
    const title = `${machineLabel(terminalMachine(address))} · ${terminal?.cwd || address}`;
    const isClosing = isTerminalClosing(address);
    return this.bar().child(div().flex_1().min_w(0).truncate().tooltip(title).text_size(12).text_color(colors.muted).child(title))
      .when(this.isConfirming, element => element
        .child(terminalButton({ id: "terminal-cancel-end", text: "Cancel", action: (_event, cx) => { this.isConfirming = false; cx.notify(); } })))
      .child(terminalButton({ id: "terminal-end", text: isClosing ? "Ending…" : this.isConfirming ? "End terminal?" : "End", isDisabled: isClosing, action: (_event, cx) => {
        if (this.isConfirming) endTerminal(address, cx);
        else { this.isConfirming = true; cx.notify(); }
      } }));
  }

  bar() {
    const colors = theme();
    return h_flex().size_full().min_w(0).gap(4).px(6).items_center().bg(colors.chrome).border_b(1).border_color(colors.border);
  }

  render() {
    if (this.newAgent) return this.newAgent.render();
    if (props()?.picker) return this.picker();
    if (props()?.terminal) return this.session(props().terminal);
    if (props()?.empty) return v_flex().size_full().p(16).gap(8).justify_center().text_size(12).text_color(theme().muted)
      .child("Your shells stay here when you hide this pane.")
      .child("Press New, or choose a computer above, to open a terminal.");
    const machine = chosenMachine();
    const isReady = isMachineReady(machine);
    const isOpening = Boolean(shared(OPENING));
    return this.bar()
      .child(terminalButton({ id: "terminal-machine-picker", text: `${machineLabel(machine)}…`, iconName: "terminal", action: pickTerminalMachine }))
      .child(terminalButton({ id: "terminal-new", text: isOpening ? "Opening…" : "New", isDisabled: !isReady || isOpening, action: () => run("pots.terminal-new") }))
      .child(div().flex_1())
      .child(terminalButton({ id: "terminal-hide", text: "Hide", action: () => run("pots.terminal") }));
  }
}
