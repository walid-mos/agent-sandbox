import { machines, props, openOverlay, closeOverlay } from "herdr";
import { TERMINAL_MOD } from "./pots-terminal-layout.js";
import { isMachineReady, machineLabel } from "./pots-machines.js";
import { listBox, listPopup, popupHeight } from "./pots-list-box.js";

/** Opens the computer picker for `purpose`: `{ key, title, label, chosen(), choose(machine) }`, which the terminal mod's view finds by `key`. */
export const pickMachine = purpose => openOverlay({
  mod: TERMINAL_MOD, kind: "popup", width: 300, height: popupHeight(machines().length), props: { picker: purpose.key },
});

export class MachinePicker {
  constructor(purpose, cx) {
    this.purpose = purpose;
    this.selected = Math.max(0, machines().findIndex(machine => machine.name === purpose.chosen()));
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(machine) {
    if (!isMachineReady(machine.name)) return;
    closeOverlay(props().overlay);
    this.purpose.choose(machine.name);
  }

  render() {
    const choices = machines();
    const chosen = this.purpose.chosen();
    this.selected = Math.max(0, Math.min(this.selected, choices.length - 1));
    return listPopup({ id: "terminal-machines", title: this.purpose.title, message: choices.length ? "" : "No computers available. Open Machines settings." })
      .child(listBox({
        id: "terminal-machine-choices", label: this.purpose.label, handle: this.handle, selected: this.selected,
        options: choices.map((machine, index) => {
          const isReady = isMachineReady(machine.name);
          const isChosen = machine.name === chosen;
          return { id: `terminal-machine-${index}`, text: machineLabel(machine.name), detail: !isReady ? machine.layout : isChosen ? "Selected" : "", isEnabled: isReady, isSelected: isChosen };
        }),
        select: index => { this.selected = index; },
        choose: index => this.choose(choices[index]),
      }));
  }
}
