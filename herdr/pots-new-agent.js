import { knownAgents, run, openOverlay, closeOverlay, props } from "herdr";
import { isMachineReady, machineLabel } from "./pots-machines.js";
import { TERMINAL_MOD } from "./pots-terminal-layout.js";
import { barButton } from "./pots-icons.js";
import { POPUP_MAX_PX, listBox, listPopup } from "./pots-list-box.js";
import { pickMachine } from "./pots-machine-picker.js";

export const AGENT_PICKER = {
  key: "agent", title: "New agent on…", label: "New agent computer",
  choose: machine => openOverlay({ mod: TERMINAL_MOD, kind: "popup", width: 320, height: POPUP_MAX_PX, props: { agents: { machine } } }),
};

export const pickAgentMachine = () => pickMachine(AGENT_PICKER);
export const newAgentToggle = () => barButton({ id: "pots-new-agent", text: "New agent…", action: pickAgentMachine });

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
      catch (error) { this.error = `Could not check agents on ${machineLabel(machine)}: ${error.message}. Cancel and try again.`; }
      finally { this.isLoading = false; cx.notify(); }
    });
  }

  launch(agent) {
    if (!agent.installed || !isMachineReady(this.machine)) return;
    closeOverlay(props().overlay);
    run("space.new", { name: agent.name, machine: this.machine ?? "", argv: agent.run, focus: true });
  }

  render() {
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
      .child(barButton({ id: "pots-agent-cancel", text: "Cancel", action: () => closeOverlay(props().overlay) }));
  }
}
