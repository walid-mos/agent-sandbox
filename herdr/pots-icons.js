import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";
import { TEXT, stopPress } from "./ui.js";

// Herdr draws an SVG from its own folder, and the installer puts the icons there beside the mod.
const ICONS = "mods/pots/icons";
const BUTTON_PX = 26;
const ICON_PX = 14;
// As tall as a secret form's field, so Save lines up beside it.
const SOLID_PX = 30;

export const icon = (name, size = ICON_PX) => svg(`${ICONS}/${name}.svg`).size(size).flex_none();

/** The button that completes a card's action, such as Save or Send, drawn dim and inert while `isEnabled` is false. */
export function solidButton({ id, text, isEnabled, action }) {
  const colors = theme();
  return h_flex().id(id).h(SOLID_PX).px(14).flex_none().items_center().rounded(8)
    .bg(isEnabled ? colors.solid : colors.hover).text_color(isEnabled ? colors.solid_foreground : colors.dim)
    .when(isEnabled, element => element.cursor_pointer().on_mouse_down("left", stopPress).on_click(action))
    .child(div().text_size(TEXT.small).font_semibold().child(text));
}

/** A quiet button: an icon, with a word beside it when the icon alone would leave the action unclear. */
export function ghostButton({ id, iconName, text = "", action, color }) {
  const colors = theme();
  return h_flex().id(id).h(BUTTON_PX).min_w(BUTTON_PX).flex_none().gap(5).px(text ? 7 : 0).justify_center().items_center()
    .rounded(6).cursor_pointer().text_color(color ?? colors.muted)
    .hover(style => style.bg(colors.hover).text_color(colors.foreground))
    .on_mouse_down("left", stopPress).on_click(action)
    .child(icon(iconName))
    .when(Boolean(text), element => element.child(div().text_size(TEXT.small).child(text)));
}
