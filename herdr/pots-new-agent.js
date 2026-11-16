import { div } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { knownAgents, run, closeOverlay, props, theme } from "herdr";
import { isMachineReady, machineLabel } from "./pots-terminal-drawer.js";

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

  key(event, cx) {
    if (event.modifiers.control || event.modifiers.platform || event.modifiers.alt || !this.agents.length) return;
    if (event.key === "down") this.selected = (this.selected + 1) % this.agents.length;
    else if (event.key === "up") this.selected = (this.selected + this.agents.length - 1) % this.agents.length;
    else if (event.key === "enter" || event.key === "space") this.launch(this.agents[this.selected]);
    else return;
    cx.stop_propagation(); cx.notify();
  }

  row(agent, index) {
    const colors = theme();
    const isEnabled = agent.installed && isMachineReady(this.machine);
    return h_flex().id(`pots-agent-${agent.key}`).h(32).px(9).gap(10).flex_none().items_center().rounded(5)
      .role("list_box_option").aria_selected(index === this.selected).disabled(!isEnabled)
      .accessibility_label(`${agent.name}${agent.installed ? "" : " · Not installed"}`)
      .when(index === this.selected, element => element.bg(colors.selected).aria_active_descendant())
      .text_size(12).text_color(isEnabled ? colors.foreground : colors.dim)
      .when(isEnabled, element => element.cursor_pointer().hover(style => style.bg(colors.hover)))
      .on_click(() => this.launch(agent))
      .child(div().flex_1().child(agent.name))
      .when(!agent.installed, element => element.child(div().text_color(colors.muted).child("Not installed")));
  }

  render() {
    const colors = theme();
    const isReady = isMachineReady(this.machine);
    const message = !isReady ? `${machineLabel(this.machine)} is unavailable. Cancel and choose another computer.`
      : this.error || (this.isLoading ? "Checking installed agents…" : this.agents.length ? "" : "No agents configured in Herdr.");
    return v_flex().id("pots-agent-picker").size_full().min_h(0).p(5).gap(2).bg(colors.popover)
      .child(div().px(9).py(8).text_size(12).text_color(colors.muted).child(`New agent on ${machineLabel(this.machine)}`))
      .when(Boolean(message), element => element.child(div().px(9).py(6).text_size(12).text_color(colors.muted).child(message)))
      .child(v_flex().id("pots-agent-choices").flex_1().min_h(0).overflow_y_scrollbar()
        .track_focus(this.handle).role("list_box").accessibility_label(`Agents on ${machineLabel(this.machine)}`)
        .on_key_down((event, cx) => this.key(event, cx))
        .children(this.agents.map((agent, index) => this.row(agent, index))))
      .child(Button.new("pots-agent-cancel").h(28).text_size(12).text_color(colors.foreground)
        .focus(style => style.border(2).border_color(colors.accent))
        .on_click(() => closeOverlay(props().overlay)).child("Cancel"));
  }
}
