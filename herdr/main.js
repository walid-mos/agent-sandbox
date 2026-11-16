import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { nextCommand, theme } from "herdr";
import { TerminalDrawer } from "./pots-terminal-drawer.js";
import { terminalToggle, pickTerminalMachine, newAgentToggle, pickAgentMachine } from "./pots-terminals.js";
import { TEXT, stopPress } from "./ui.js";
import { PotsPanel, isCompact } from "./pots-panel.js";
import { SANDBOXES } from "./sandboxes.js";
import { chosenSandbox, chooseSandbox } from "./pots-source.js";

function chip({ id, text, isOn, action }) {
  const colors = theme();
  return h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).cursor_pointer()
    .when(isOn, element => element.bg(colors.selected))
    .hover(style => style.bg(colors.hover)).on_mouse_down("left", stopPress).on_click(action)
    .child(div().text_size(TEXT.small).text_color(isOn ? colors.foreground : colors.muted).child(text));
}

export default class Pots extends View {
  init(_props, cx) {
    this.terminals = new TerminalDrawer(cx);
    this.openSections = new Set();
    this.width = Infinity;
    this.panels = new Map(SANDBOXES.map(sandbox => [sandbox, new PotsPanel(cx, sandbox)]));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.panels.get(chosenSandbox()).focus();
        if (command === "switch") this.choose(SANDBOXES[(SANDBOXES.indexOf(chosenSandbox()) + 1) % SANDBOXES.length], cx);
        if (command === "terminal") this.terminals.toggle(cx);
        if (command === "terminal-new") this.terminals.open(cx);
        if (command === "terminal-next") this.terminals.next();
        if (command === "terminal-machine") pickTerminalMachine();
        if (command === "new-agent") pickAgentMachine();
        cx.notify();
      }
    });
  }

  choose(sandbox, cx) {
    chooseSandbox(sandbox);
    this.panels.get(sandbox).show(cx);
    cx.notify();
  }

  toggleSection(id, cx) {
    if (this.openSections.has(id)) this.openSections.delete(id);
    else this.openSections.add(id);
    cx.notify();
  }

  sandboxTab(sandbox) {
    return chip({
      id: `pots-sandbox-${sandbox.machine}`, text: sandbox.bot, isOn: sandbox === chosenSandbox(),
      action: (_event, cx) => this.choose(sandbox, cx),
    });
  }

  sectionToggle({ id, title }) {
    return chip({
      id: `pots-section-${id}`, text: title, isOn: this.openSections.has(id),
      action: (_event, cx) => this.toggleSection(id, cx),
    });
  }

  render() {
    const colors = theme();
    const panel = this.panels.get(chosenSandbox());
    const bar = () => h_flex().w_full().flex_none().flex_wrap().gap(4).px(10).py(6).border_b(1).border_color(colors.border);
    const tabs = SANDBOXES.length > 1 ? SANDBOXES.map(sandbox => this.sandboxTab(sandbox)) : [];
    const toggles = panel.sections().map(section => this.sectionToggle(section));
    const compact = isCompact(this.width);
    const top = bar().child(newAgentToggle()).child(terminalToggle());
    const bars = compact
      ? [top, ...(tabs.length ? [bar().children(tabs)] : []), bar().children(toggles)]
      : [top.children(tabs).child(div().flex_1()).children(toggles)];
    return v_flex().id("pots").size_full().min_w(0).min_h(0).bg(colors.background)
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .children(bars).child(panel.render(this.openSections, compact));
  }
}
