import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme } from "herdr";

export const POPUP_MAX_PX = 420;
const POPUP_PAD_PX = 5;
const ROW_PX = 32;
const ROW_GAP_PX = 2;

/** The height of a list popup whose list holds `rows` options, up to POPUP_MAX_PX. */
export const popupHeight = rows => Math.min(POPUP_MAX_PX, rows * (ROW_PX + ROW_GAP_PX) + ROW_PX + 2 * POPUP_PAD_PX);

/** A popup's frame: its title, then `message` when there is one. Add the list box, and any button, as children. */
export function listPopup({ id, title, message }) {
  const colors = theme();
  return v_flex().id(id).size_full().min_h(0).p(POPUP_PAD_PX).gap(ROW_GAP_PX).bg(colors.popover)
    .child(div().h(ROW_PX).px(9).py(8).text_size(12).text_color(colors.muted).child(title))
    .when(Boolean(message), element => element.child(div().px(9).py(6).text_size(12).text_color(colors.muted).child(message)));
}

/**
 * Options `{ id, text, detail, isEnabled, isSelected }` that Up and Down move through, wrapping, and Enter, Space or a click choose.
 * A key held with Control, Command or Alt stays Herdr's. `detail` shows at the end of the row.
 */
export function listBox({ id, label, handle, options, selected, select, choose }) {
  const colors = theme();
  return v_flex().id(id).flex_1().min_h(0).gap(ROW_GAP_PX).overflow_y_scrollbar()
    .track_focus(handle).role("list_box").accessibility_label(label)
    .on_key_down((event, cx) => {
      if (event.modifiers.control || event.modifiers.platform || event.modifiers.alt || !options.length) return;
      if (event.key === "down") select((selected + 1) % options.length);
      else if (event.key === "up") select((selected + options.length - 1) % options.length);
      else if (event.key === "enter" || event.key === "space") choose(selected);
      else return;
      cx.stop_propagation(); cx.notify();
    })
    .children(options.map((option, index) => h_flex().id(option.id).h(ROW_PX).px(9).gap(10).flex_none().items_center().rounded(5)
      .role("list_box_option").aria_selected(option.isSelected).disabled(!option.isEnabled)
      .accessibility_label(option.isEnabled || !option.detail ? option.text : `${option.text} · ${option.detail}`)
      .when(index === selected, element => element.bg(colors.selected).aria_active_descendant())
      .text_size(12).text_color(option.isEnabled ? colors.foreground : colors.dim)
      .when(option.isEnabled, element => element.cursor_pointer().hover(style => style.bg(colors.hover)))
      .on_click(() => choose(index))
      .child(div().flex_1().child(option.text))
      .when(Boolean(option.detail), element => element.child(div().text_color(colors.muted).child(option.detail)))));
}
