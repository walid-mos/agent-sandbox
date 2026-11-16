import { div, image } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { theme } from "herdr";
import { TEXT, label, stopPress } from "./ui.js";
import { textBeforeEnter } from "./pots-enter.js";
import { stageFile, stageClipboard, chooseFiles, unstage } from "./pots-attachments.js";
import { failureText } from "./pots-source.js";
import { icon, ghostButton } from "./pots-icons.js";
import { COLUMN_PX } from "./pots-message.js";

const MAX_ROWS = 8;
const MAX_ATTACHMENTS = 8;
const ATTACHMENT_PX = 56;
const REMOVE_PX = 18;
const SEND_PX = 30;
const HINT = "Enter to send · Shift+Enter for a new line";

/** What the person is writing to one bot: the text, and the files that leave with it. */
export class Composer {
  constructor(placeholder, send, hintFor) {
    this.send = send;
    this.hintFor = hintFor;
    this.shownHint = "";
    this.attachments = [];
    this.staging = 0;
    this.isSendPending = false;
    this.error = "";
    this.notice = "";
    this.isFocused = false;
    this.before = "";
    this.text = "";
    this.input = TextareaState.new({ placeholder });
    this.input.set_auto_grow(1, MAX_ROWS);
    this.input.on("change", (_event, cx) => {
      this.before = this.text;
      this.text = this.input.value();
      if (this.hintText() !== this.shownHint) cx.notify();
    });
    this.input.on("submit", (event, cx) => this.enter(event, cx));
    this.input.on("paste_other", (_event, cx) => this.stage([stageClipboard], cx));
    this.input.on("focus", (_event, cx) => { this.isFocused = true; cx.notify(); });
    this.input.on("blur", (_event, cx) => { this.isFocused = false; cx.notify(); });
  }

  focus() { this.input.focus(); }

  /** Whatever changes the card's height, so the conversation above can keep its newest message in view. */
  heightKey() {
    const lines = Math.min(this.text.split("\n").length, MAX_ROWS);
    return `${lines}:${this.attachments.length}:${Boolean(this.error)}:${Boolean(this.notice)}`;
  }

  isEmpty() { return !this.input.value().trim() && !this.attachments.length && !this.staging; }

  /** A file still being staged is part of what the person wrote, so the send waits for it. */
  isWaitingForFiles() { return this.staging > 0; }

  write(text) {
    this.input.set_value(text);
    this.input.set_selected_range({ start: text.length, end: text.length });
    this.before = this.text = text;
  }

  enter(event, cx) {
    const after = this.input.value();
    // An edit that reported no change leaves the record stale: the text then stays as it is.
    const written = after === this.text ? textBeforeEnter(this.before, after) : after;
    this.before = this.text = after;
    if (event.shift) return;
    this.write(written);
    if (this.isWaitingForFiles()) { this.isSendPending = true; return; }
    this.send(cx);
  }

  hint() { return this.hintFor(this.draft()); }

  // Hint texts tell hints apart: an error never reads like what Enter runs.
  hintText() { return this.hint()?.text ?? HINT; }

  /** The message as it stands, left in the composer. */
  draft() { return { text: this.input.value().trim(), attachments: this.attachments }; }

  /** The message as it stands. Taking it empties the composer. */
  take() {
    const draft = this.draft();
    this.write("");
    this.attachments = [];
    this.error = "";
    this.notice = "";
    return draft;
  }

  /** One line above the composer: what a command did, or why it did not run. */
  report({ notice = "", error = "" }, cx) {
    this.notice = notice;
    this.error = error;
    cx.notify();
  }

  /** A draft that did not leave comes back, unless the person has written something else since. Reports whether it did. */
  restore(draft) {
    if (this.input.value()) return false;
    this.write(draft.text);
    this.attachments = [...draft.attachments, ...this.attachments].slice(0, MAX_ATTACHMENTS);
    return true;
  }

  stage(sources, cx) {
    const isOver = this.attachments.length + this.staging + sources.length > MAX_ATTACHMENTS;
    this.error = isOver ? `A message carries up to ${MAX_ATTACHMENTS} files.` : "";
    cx.notify();
    if (isOver) return;
    this.staging += sources.length;
    cx.spawn(async cx => {
      const results = await Promise.allSettled(sources.map(source => source()));
      this.staging -= sources.length;
      this.attachments.push(...results.filter(result => result.status === "fulfilled").map(result => result.value));
      const failure = results.find(result => result.status === "rejected");
      if (failure) this.error = failureText(failure.reason, "The file could not be attached.");
      if (this.isSendPending && !this.isWaitingForFiles()) { this.isSendPending = false; this.send(cx); return; }
      cx.notify();
    });
  }

  drop(paths, cx) { this.stage(paths.map(path => () => stageFile(path)), cx); }

  choose(cx) {
    cx.spawn(async cx => {
      try { this.drop(await chooseFiles(), cx); }
      catch (error) { this.error = failureText(error, "The file chooser did not open."); cx.notify(); }
      this.input.focus();
    });
  }

  detach(attachment, cx) {
    this.attachments = this.attachments.filter(kept => kept !== attachment);
    unstage(attachment);
    cx.notify();
  }

  attachmentTile(attachment) {
    const colors = theme();
    const content = attachment.preview
      ? image(attachment.preview).h(ATTACHMENT_PX)
      : h_flex().h_full().gap(6).items_center().pl(10).pr(REMOVE_PX + 10).bg(colors.surface)
        .child(icon("file").text_color(colors.muted)).child(label(attachment.name, TEXT.small, colors.foreground));
    return div().id(`pots-attachment-${attachment.id}`).relative().flex_none().h(ATTACHMENT_PX)
      .rounded(10).overflow_hidden().border_1().border_color(colors.border).child(content)
      .child(div().id(`pots-detach-${attachment.id}`).absolute().top(4).right(4).size(REMOVE_PX).rounded_full()
        .flex().items_center().justify_center().bg(colors.raised).text_color(colors.foreground).shadow_sm()
        .cursor_pointer().on_mouse_down("left", stopPress).on_click((_event, cx) => this.detach(attachment, cx)).child(icon("x", 11)));
  }

  sendButton() {
    const colors = theme();
    const canSend = !this.isEmpty();
    return div().id("pots-send").size(SEND_PX).flex_none().rounded_full().flex().items_center().justify_center()
      .bg(canSend ? colors.solid : colors.hover).text_color(canSend ? colors.solid_foreground : colors.dim)
      .cursor_pointer().on_mouse_down("left", stopPress).on_click((_event, cx) => this.send(cx)).child(icon("arrow-up", 16));
  }

  render() {
    const hint = this.hint();
    this.shownHint = hint?.text ?? HINT;
    const colors = theme();
    const card = v_flex().w_full().rounded(16).border_1().border_color(this.isFocused ? colors.dim : colors.border)
      .bg(colors.background).shadow_sm()
      .when(this.attachments.length > 0, element => element.child(h_flex().w_full().flex_wrap().gap(8).px(12).pt(12)
        .children(this.attachments.map(attachment => this.attachmentTile(attachment)))))
      .child(h_flex().w_full().px(14).pt(12).pb(2)
        .child(Textarea.new(this.input).flex_1().min_w(0).text_size(TEXT.body).text_color(colors.foreground)))
      .child(h_flex().w_full().gap(8).px(8).pb(8).items_center()
        .child(ghostButton({ id: "pots-attach", iconName: "paperclip", text: "Attach", action: (_event, cx) => this.choose(cx) }))
        .child(div().flex_1())
        .child(label(hint?.text ?? HINT, TEXT.micro, hint?.isError ? colors.blocked : colors.dim))
        .child(this.sendButton()));
    return v_flex().w_full().flex_none().items_center().px(24).pt(4).pb(16)
      .child(v_flex().w_full().max_w(COLUMN_PX).gap(6)
        .when(Boolean(this.error), element => element.child(label(this.error, TEXT.small, colors.blocked).px(4)))
        .when(Boolean(this.notice), element => element.child(label(this.notice, TEXT.small, colors.muted).px(4)))
        .child(card));
  }
}
