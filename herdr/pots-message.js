import { div, image } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme } from "herdr";
import { TEXT, label, elapsed } from "./ui.js";
import { icon } from "./pots-icons.js";

/** Messages read best at a book's line length, so the conversation and the composer share one centered column. */
export const COLUMN_PX = 760;
const BUBBLE_MAX_PX = 560;
const THUMBNAIL_PX = 140;
const FILE_CHIP_PX = 32;
const AVATAR_PX = 22;
const SENDING_OPACITY = 0.6;

function attachmentView(attachment, key) {
  const colors = theme();
  if (attachment.preview) {
    return div().id(key).flex_none().rounded(10).overflow_hidden().border_1().border_color(colors.border)
      .child(image(attachment.preview).h(THUMBNAIL_PX));
  }
  return h_flex().id(key).flex_none().h(FILE_CHIP_PX).gap(6).px(10).items_center().rounded(8)
    .border_1().border_color(colors.border).bg(colors.surface)
    .child(icon("file").text_color(colors.muted)).child(label(attachment.name, TEXT.small, colors.foreground));
}

function attachmentRow(id, attachments, isMine) {
  return h_flex().w_full().flex_wrap().gap(6).when(isMine, element => element.justify_end())
    .children(attachments.map((attachment, index) => attachmentView(attachment, `${id}-file-${index}`)));
}

function avatar(bot) {
  const colors = theme();
  return div().size(AVATAR_PX).flex_none().rounded_full().flex().items_center().justify_center()
    .bg(colors.accent).text_color(colors.accent_foreground).text_size(TEXT.micro).font_semibold().child(bot.slice(0, 1).toUpperCase());
}

/** What the person wrote: a bubble on the right, under the files it carries. */
export function personMessage({ id, text, attachments, isLeaving = false }) {
  const colors = theme();
  return v_flex().w_full().items_end().gap(6).opacity(isLeaving ? SENDING_OPACITY : 1)
    .when(attachments.length > 0, element => element.child(attachmentRow(id, attachments, true)))
    .when(Boolean(text), element => element.child(div().max_w(BUBBLE_MAX_PX).px(14).py(9).rounded(16)
      .bg(colors.selected).text_size(TEXT.body).text_color(colors.foreground).child(text)));
}

/** What the bot answered: its name, then the answer as the page itself, the way current agent chats show a reply. */
export function botMessage({ id, bot, at, text, attachments }) {
  const colors = theme();
  return v_flex().w_full().gap(8)
    .child(h_flex().gap(8).items_center().child(avatar(bot))
      .child(label(bot, TEXT.small, colors.foreground).font_semibold())
      .when(Boolean(at), element => element.child(label(elapsed(at), TEXT.micro, colors.dim))))
    .when(Boolean(text), element => element.child(div().w_full().min_w(0).text_size(TEXT.body).text_color(colors.foreground)
      .child(TextView.markdown(`pots-text-${id}`, text))))
    .when(attachments.length > 0, element => element.child(attachmentRow(id, attachments, false)));
}

export function emptyConversation(bot, text) {
  return v_flex().w_full().items_center().gap(10).py(48).child(avatar(bot)).child(label(text, TEXT.body, theme().muted));
}
