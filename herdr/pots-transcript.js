import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { theme } from "herdr";
import { TEXT, label, elapsed } from "./ui.js";
import { loadSteps, failureText, isFromBot } from "./pots-source.js";
import { icon, ghostButton } from "./pots-icons.js";
import { COLUMN_PX, personMessage, botMessage, emptyConversation } from "./pots-message.js";

const COPIED_MS = 1500;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const OUTGOING_STATE = { sending: "Sending…", sent: "Sent", failed: "Not sent" };
const HELD = "Waits for the message above";
const SPIN_MS = 900;
const PULSE = { from: 0.55, to: 1, period: 1600 };
const FADE = { duration: 120, easing: "ease-out" };
const WORKING_KEY = "pots-working";

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / MS_PER_SECOND));
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} s`;
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)} min ${seconds % SECONDS_PER_MINUTE} s`;
}

function stepsSummary({ modelCalls, tools }) {
  const failed = tools.filter(step => step.outcome !== "done").length;
  return [plural(modelCalls, "model call"), plural(tools.length, "tool call"), failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
}

function toolRow(step, key) {
  const colors = theme();
  const isDone = step.outcome === "done";
  return h_flex().id(`pots-step-${key}`).w_full().gap(8)
    .child(label(step.tool, TEXT.small, colors.foreground).flex_1())
    .when(!isDone, element => element.child(label(step.outcome, TEXT.micro, colors.blocked).flex_none()))
    .child(label(step.duration, TEXT.micro, colors.dim).flex_none());
}

const row = id => v_flex().id(id).w_full().max_w(COLUMN_PX).flex_none();

/** The conversation with one bot: messages, the ones still leaving, and whether the bot works on them. */
export class Transcript {
  constructor(sandbox) {
    this.sandbox = sandbox;
    this.scroll = ScrollHandle.new();
    this.lastKey = "";
    this.hovered = "";
    this.copied = "";
    this.activities = new Map();
    this.expanded = new Set();
  }

  /** The conversation scrolls to its end when a message arrives or the panes around it change height,
   *  because Herdr reveals a row once and a later shrink would hide it again. */
  follow(key, count) {
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.scroll.scroll_to_item(count - 1);
  }

  hover(id, isHovered, cx) {
    if (isHovered) this.hovered = id;
    else if (this.hovered === id) this.hovered = "";
    cx.notify();
  }

  copy(id, text, cx) {
    cx.write_to_clipboard(text);
    this.copied = id;
    cx.notify();
    cx.timer.after(COPIED_MS, cx => { if (this.copied === id) { this.copied = ""; cx.notify(); } });
  }

  toggleSteps(sendId, cx) {
    const isOpen = this.expanded.has(sendId);
    if (isOpen) this.expanded.delete(sendId);
    else this.expanded.add(sendId);
    cx.notify();
    if (isOpen || ["loading", "ready"].includes(this.activities.get(sendId)?.state)) return;
    this.activities.set(sendId, { state: "loading" });
    cx.spawn(async cx => {
      try { this.activities.set(sendId, { state: "ready", steps: await loadSteps(this.sandbox, sendId) }); }
      catch (error) { this.activities.set(sendId, { state: "failed", error: failureText(error, "The steps could not load.") }); }
      cx.notify();
    });
  }

  steps(sendId) {
    const colors = theme();
    const activity = this.activities.get(sendId) ?? { state: "loading" };
    const frame = v_flex().w_full().gap(4).px(12).py(10).rounded(10).border_1().border_color(colors.border).bg(colors.surface);
    if (activity.state === "loading") return frame.child(label("Loading what it did…", TEXT.small, colors.dim));
    if (activity.state === "failed") return frame.child(label(activity.error, TEXT.small, colors.blocked));
    return frame.child(label(stepsSummary(activity.steps), TEXT.small, colors.muted))
      .children(activity.steps.tools.map((step, index) => toolRow(step, `${sendId}-${index}`)));
  }

  actions(message, isBot, isLast) {
    const isShown = isLast || this.hovered === message.id;
    const isCopied = this.copied === message.id;
    return h_flex().h(26).gap(2).items_center().opacity(isShown ? 1 : 0).transition("opacity", FADE)
      .when(!isBot, element => element.justify_end()
        .when(Boolean(message.at), inner => inner.child(label(elapsed(message.at), TEXT.micro, theme().dim).mr(4))))
      .when(Boolean(message.text), element => element.child(ghostButton({
        id: `pots-copy-${message.id}`, iconName: isCopied ? "check" : "copy", text: isCopied ? "Copied" : "",
        action: (_event, cx) => this.copy(message.id, message.text, cx),
      })))
      .when(isBot && Boolean(message.sendId), element => element.child(ghostButton({
        id: `pots-steps-${message.id}`, iconName: "list-tree", text: this.expanded.has(message.sendId) ? "Hide steps" : "What it did",
        action: (_event, cx) => this.toggleSteps(message.sendId, cx),
      })));
  }

  messageRow(message, { bot, outbox, below, isLast }) {
    const isBot = isFromBot(message);
    const attachments = outbox.attachmentsOf(message.id) ?? message.files.map(name => ({ name, preview: null }));
    const content = { ...message, attachments };
    const extra = below(message);
    return row(`pots-message-${message.id}`).gap(2)
      .on_hover((isHovered, cx) => this.hover(message.id, isHovered, cx))
      .child(isBot ? botMessage({ ...content, bot }) : personMessage(content))
      .when(Boolean(extra), element => element.child(extra))
      .child(this.actions(message, isBot, isLast))
      .when(isBot && this.expanded.has(message.sendId), element => element.child(this.steps(message.sendId)));
  }

  outgoingRow(item, outbox) {
    const colors = theme();
    const isFailed = item.state === "failed";
    const key = `pots-outgoing-${item.id}`;
    const status = isFailed ? `Not sent. ${item.error}` : outbox.isHeld(item) ? HELD : OUTGOING_STATE[item.state];
    return row(key).gap(4)
      .child(personMessage({ id: key, text: item.draft.text, attachments: item.draft.attachments, isLeaving: !isFailed }))
      .child(h_flex().w_full().gap(2).justify_end().items_center()
        .child(label(status, TEXT.micro, isFailed ? colors.blocked : colors.dim).mr(4))
        .when(isFailed, element => element
          .child(ghostButton({ id: `${key}-retry`, iconName: "rotate-ccw", text: "Retry", action: (_event, cx) => outbox.deliver(item, cx) }))
          .child(ghostButton({ id: `${key}-edit`, iconName: "pencil", text: "Edit", action: (_event, cx) => outbox.edit(item, cx) }))));
  }

  statusRow({ bot, activity, waitingSince }) {
    const colors = theme();
    if (activity === "offline") return row(WORKING_KEY).child(label(`${bot} is not running. Messages wait until it starts.`, TEXT.small, colors.dim));
    return row(WORKING_KEY).child(h_flex().gap(8).items_center()
      .child(icon("loader-circle").text_color(colors.accent).spin(SPIN_MS))
      .child(label(`${bot} is working · ${duration(Date.now() - waitingSince)}`, TEXT.small, colors.muted).loop("opacity", PULSE)));
  }

  /** `waiting` holds the bot's state while it owes an answer, and is null otherwise.
   *  `below` draws what goes under a message, or returns null for nothing. */
  render({ bot, messages, outbox, below, waiting, emptyText, layoutKey }) {
    const outgoing = outbox.unshown(messages);
    const rows = [...messages.map(message => message.id), ...outgoing.map(item => item.id)];
    // With no rows the empty-conversation row is drawn in their place, so there is always one to scroll to.
    this.follow(`${rows.at(-1) ?? ""}:${Boolean(waiting)}:${layoutKey}`, (rows.length || 1) + (waiting ? 1 : 0));
    return v_flex().id("pots-transcript").flex_1().min_h(0).items_center().gap(10).px(24).py(20).overflow_y_scrollbar().track_scroll(this.scroll)
      .when(!rows.length, element => element.child(row("pots-empty").child(emptyConversation(bot, emptyText))))
      .children(messages.map((message, index) => this.messageRow(message, { bot, outbox, below, isLast: index === messages.length - 1 && !outgoing.length })))
      .children(outgoing.map(item => this.outgoingRow(item, outbox)))
      .when(Boolean(waiting), element => element.child(this.statusRow({ bot, ...waiting })));
  }
}
