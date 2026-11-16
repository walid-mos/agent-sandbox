import { sendMessage, failureText, isFromBot } from "./pots-source.js";

// The gateway wakes the bot a moment after a message lands: until then the bot reads as idle.
const WAKE_GRACE_MS = 15000;

let posted = 0;

/** Messages on their way to one bot. Each shows in the conversation at once and leaves the outbox when a snapshot holds it. */
export class Outbox {
  constructor(sandbox, onChange, onLoad, giveBack) {
    this.sandbox = sandbox;
    this.onChange = onChange;
    this.onLoad = onLoad;
    this.giveBack = giveBack;
    this.items = [];
    this.delivered = new Map();
    this.deliveredAt = 0;
    this.isPumping = false;
  }

  post(draft, cx) {
    // The pane names the message, so a send whose answer is lost is recognised rather than written twice.
    const item = { id: `m-${Date.now()}-${++posted}`, draft, state: "sending", error: "" };
    this.items = [...this.items, item];
    this.onChange(cx);
    this.deliver(item, cx);
  }

  update(item, change) {
    this.items = this.items.map(kept => (kept.id === item.id ? { ...kept, ...change } : kept));
  }

  /** A message whose state the pane changed leaves on its own, so nothing loads until it has left or failed. */
  deliver(item, cx) {
    this.update(item, { state: "sending", error: "" });
    this.pump(cx);
  }

  /**
   * Messages leave in the order they were written. One that fails holds the ones after it, so the bot never reads a
   * later message as an answer to an earlier one.
   */
  pump(cx) {
    if (this.isPumping) return;
    this.isPumping = true;
    cx.spawn(async cx => {
      try {
        for (;;) {
          const next = this.items.find(kept => kept.state !== "sent");
          if (!next) return;
          if (next.state !== "sending") return;
          if (!(await this.leave(next))) return;
        }
      }
      finally { this.isPumping = false; this.onChange(cx); this.onLoad(cx); }
    });
  }

  async leave(item) {
    try {
      await sendMessage(this.sandbox, { id: item.id, text: item.draft.text, attachments: item.draft.attachments });
      this.update(item, { state: "sent" });
      this.reachedBot();
      this.delivered.set(item.id, item.draft.attachments);
      return true;
    }
    catch (error) {
      this.update(item, { state: "failed", error: failureText(error, "The message could not be sent.") });
      return false;
    }
  }

  /** A message waiting behind one that failed: it leaves once that one is retried or edited away. */
  isHeld(item) {
    const failedAt = this.items.findIndex(kept => kept.state === "failed");
    return item.state === "sending" && failedAt >= 0 && failedAt < this.items.findIndex(kept => kept.id === item.id);
  }

  /** A message leaving now, or next in line: neither failed nor held behind one that did. */
  isOnItsWay(item) { return item.state === "sending" && !this.isHeld(item); }

  /** A message that did not leave goes back to the composer, unless the composer holds text of its own. */
  edit(item, cx) {
    if (!this.giveBack(item.draft)) return;
    this.items = this.items.filter(kept => kept.id !== item.id);
    this.pump(cx);
    this.onChange(cx);
  }

  /** The files a message left with, while this pane still holds them, so the conversation can draw them. */
  attachmentsOf(messageId) { return this.delivered.get(messageId) ?? null; }

  unshown(messages) {
    const shown = new Set(messages.map(message => message.id));
    return this.items.filter(item => !shown.has(item.id));
  }

  /** Something the person sent just reached the bot, which reads as idle until the gateway wakes it. */
  reachedBot() { this.deliveredAt = Date.now(); }

  settle(messages) { this.items = this.unshown(messages); }

  isAwaitingReply(lastMessage) {
    const isUnanswered = !isFromBot(lastMessage) && Date.now() - this.deliveredAt < WAKE_GRACE_MS;
    return isUnanswered || this.items.some(item => this.isOnItsWay(item));
  }
}
