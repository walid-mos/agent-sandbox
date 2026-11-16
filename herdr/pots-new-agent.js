import { Button } from "gpui-base";
import { knownAgents, run, closeOverlay, props, theme } from "herdr";
import { isMachineReady, machineLabel } from "./pots-terminal-drawer.js";
import { listBox, listPopup } from "./pots-list-box.js";

export class NewAgent {
  constructor(machine, cx) {
    this.machine = machine;
    this.agents = [];
    this.isLoading = true;
    this.error = "";
    this.selected = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try { this.agents = await knownAgents({ on: machine }); }
      catch { this.error = `Could not check agents on ${machineLabel(machine)}. Cancel and try again.`; }
      finally { this.isLoading = false; cx.notify(); }
    });
  }

  launch(agent) {
    if (!agent.installed || !isMachineReady(this.machine)) return;
    closeOverlay(props().overlay);
    run("space.new", { name: agent.name, machine: this.machine ?? "", argv: agent.run, focus: true });
  }

  render() {
    const colors = theme();
    const isReady = isMachineReady(this.machine);
    const message = !isReady ? `${machineLabel(this.machine)} is unavailable. Cancel and choose another computer.`
      : this.error || (this.isLoading ? "Checking installed agents…" : this.agents.length ? "" : "No agents configured in Herdr.");
    return listPopup({ id: "pots-agent-picker", title: `New agent on ${machineLabel(this.machine)}`, message })
      .child(listBox({
        id: "pots-agent-choices", label: `Agents on ${machineLabel(this.machine)}`, handle: this.handle, selected: this.selected,
        options: this.agents.map((agent, index) => ({
          id: `pots-agent-${agent.key}`, text: agent.name, detail: agent.installed ? "" : "Not installed",
          isEnabled: agent.installed && isReady, isSelected: index === this.selected,
        })),
        select: index => { this.selected = index; },
        choose: index => this.launch(this.agents[index]),
      }))
      .child(Button.new("pots-agent-cancel").h(28).text_size(12).text_color(colors.foreground)
        .focus(style => style.border(2).border_color(colors.accent))
        .on_click(() => closeOverlay(props().overlay)).child("Cancel"));
  }
}
