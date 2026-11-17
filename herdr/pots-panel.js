import { h_flex, v_flex } from "gpui-base";
import { theme, settings, shared, setShared } from "herdr";
import { POTS_STATUS } from "./state.js";
import { TEXT, STATES, label, statusGlyph, textButton } from "./ui.js";
import { loadSnapshot, stopWorker, openWorker, chosenSandbox, failureText, isFromBot } from "./pots-source.js";
import { Composer } from "./pots-composer.js";
import { Outbox } from "./pots-outbox.js";
import { Transcript } from "./pots-transcript.js";
import { SecretForms } from "./pots-vault-forms.js";
import { commandIn, commandHint, runCommand } from "./pots-commands.js";
import { WorkerDialogs } from "./pots-dialogs.js";
import { QuestionCards, answersTo } from "./pots-questions.js";
import { section, note, wakeRows, factRows } from "./pots-sections.js";

const REFRESH_MS = 5000;
const WAITING_REFRESH_MS = 1000;
const SIDEBAR_PX = 330;
const CHAT_MIN_PX = 400;
const COMPACT_SIDEBAR_PX = 200;
const UNKNOWN_WORKER_STATE = "blocked";
const LOADING = "Loading…";
const CONNECTING = "Connecting…";

/** A measured width is in screen points, while every size written here grows with the person's zoom. */
export const isCompact = width => width / (Number(settings().zoom) || 1) < SIDEBAR_PX + CHAT_MIN_PX;

/** One sandbox's bot. Each sandbox keeps its own panel, so a draft, a send under way and an error stay with their bot. */
export class PotsPanel {
  constructor(cx, sandbox) {
    this.sandbox = sandbox;
    this.snapshot = null;
    this.error = "";
    this.connectionError = "";
    this.isLoading = false;
    this.isRefreshOwed = false;
    this.refreshedAt = 0;
    this.waitingSince = 0;
    this.stopping = "";
    this.composer = new Composer(`Message ${sandbox.bot}…`, cx => this.send(cx), draft => {
      const command = this.commandOf(draft);
      return command && commandHint(command, sandbox.bot);
    });
    this.outbox = new Outbox(sandbox, cx => this.changed(cx), cx => this.refresh(cx), draft => {
      const isRestored = this.composer.restore(draft);
      this.composer.focus();
      return isRestored;
    });
    this.transcript = new Transcript(sandbox);
    this.secrets = new SecretForms(sandbox, {
      onAnswered: cx => { this.outbox.reachedBot(); this.changed(cx); this.refreshAfterChange(cx); },
      onFailed: cx => this.refreshAfterChange(cx),
    });
    this.dialogs = new WorkerDialogs(sandbox, cx => this.refresh(cx));
    this.questions = new QuestionCards((text, cx, questionId) => this.outbox.post({ text, questionId, attachments: [] }, cx));
    this.show(cx);
    cx.timer.every(WAITING_REFRESH_MS, cx => this.tick(cx));
  }

  focus() { this.composer.focus(); }

  isShown() { return chosenSandbox() === this.sandbox; }

  show(cx) { this.publish(); this.refresh(cx); }

  state() {
    if (this.connectionError) return "offline";
    if (!this.snapshot) return "starting";
    if (this.snapshot.bot.activity === "offline") return "offline";
    return this.isWaiting() ? "working" : "ready";
  }

  /** The bot owes an answer: it works, or a message is on its way to it or has just reached it. */
  isWaiting() {
    return this.snapshot?.bot.activity === "working" || this.outbox.isAwaitingReply(this.snapshot?.messages.at(-1)) || this.secrets.isAwaitingReply();
  }

  /** Whatever changes whether the bot owes an answer comes through here, so the count and the header follow it. */
  changed(cx) {
    if (!this.isWaiting()) this.waitingSince = 0;
    else if (!this.waitingSince) this.waitingSince = Date.now();
    this.publish();
    cx.notify();
  }

  /** While the bot owes an answer, the pane looks every second and counts the time; otherwise every five. */
  tick(cx) {
    if (this.isWaiting()) { this.poll(cx); cx.notify(); return; }
    if (this.waitingSince) this.changed(cx);
    if (Date.now() - this.refreshedAt >= REFRESH_MS) this.poll(cx);
  }

  /** A timed look skips a load already running rather than queueing behind it: nothing changed that it would miss. */
  poll(cx) {
    if (!this.isLoading) this.refresh(cx);
  }

  /** The pane draws no header: the layout showing it reads this to draw one in its own style. */
  publish() {
    if (!this.isShown()) return;
    const status = { state: this.state(), model: this.snapshot?.bot.model ?? "", bot: this.sandbox.bot };
    if (JSON.stringify(shared(POTS_STATUS)) !== JSON.stringify(status)) setShared(POTS_STATUS, status);
  }

  /** A refresh asked for while a load runs follows it, since that load may predate what the caller just changed. */
  refresh(cx) {
    if (!this.isShown()) return;
    if (this.isLoading) { this.isRefreshOwed = true; return; }
    this.isLoading = true;
    this.isRefreshOwed = false;
    this.refreshedAt = Date.now();
    cx.spawn(async cx => {
      try {
        this.snapshot = await loadSnapshot(this.sandbox);
        this.connectionError = "";
        this.outbox.settle(this.snapshot.messages);
        this.secrets.sync(this.snapshot.messages);
        this.dialogs.sync(this.snapshot.workers);
      }
      catch (error) { this.connectionError = failureText(error, `${this.sandbox.bot} could not connect.`); }
      finally { this.isLoading = false; this.changed(cx); if (this.isRefreshOwed) this.refresh(cx); }
    });
  }

  /** A refresh under way may have started before the change, so the one asked here then runs once it ends. */
  refreshAfterChange(cx) {
    this.isRefreshOwed = true;
    this.refresh(cx);
  }

  send(cx) {
    if (this.composer.isEmpty()) return;
    const draft = this.composer.take();
    const command = this.commandOf(draft);
    if (command) this.command(command, draft, cx);
    else this.outbox.post(draft, cx);
  }

  /** A command's answer shows above the composer; a command that fails goes back into it to be corrected. */
  command(command, draft, cx) {
    cx.spawn(async cx => {
      try { this.composer.report({ notice: await runCommand(this.sandbox, command) }, cx); this.refresh(cx); }
      catch (error) {
        this.composer.restore(draft);
        this.composer.report({ error: failureText(error, `/${command.name} did not run.`) }, cx);
      }
    });
  }

  commandOf(draft) { return commandIn(draft, this.snapshot?.workers ?? []); }

  stop(worker, cx) {
    if (this.stopping !== worker.name) { this.stopping = worker.name; cx.notify(); return; }
    this.stopping = "";
    cx.spawn(async cx => {
      try { await stopWorker(this.sandbox, worker); this.error = ""; this.refresh(cx); }
      catch (error) { this.error = failureText(error, "The worker could not stop."); }
      cx.notify();
    });
  }

  workerRow(worker) {
    const colors = theme();
    const state = Object.hasOwn(STATES, worker.status) ? worker.status : UNKNOWN_WORKER_STATE;
    const dialog = this.dialogs.render(worker);
    return v_flex().id(`pots-worker-${worker.name}`).w_full().flex_none().gap(4).py(6)
      .child(h_flex().gap(7).child(statusGlyph(state, worker.name))
        .child(label(worker.title, TEXT.body, colors.foreground).flex_1())
        .child(label(STATES[state].label, TEXT.micro, colors[STATES[state].color]).flex_none()))
      .child(label(`${worker.repository} · ${worker.branch}`, TEXT.micro, colors.dim))
      .child(h_flex().gap(4)
        .when(Boolean(worker.terminal), element => element.child(textButton({ id: `open-${worker.name}`, text: "Open", action: () => openWorker(this.sandbox, worker) })))
        .child(textButton({ id: `stop-${worker.name}`, text: this.stopping === worker.name ? "Confirm stop" : "Stop", action: (_event, cx) => this.stop(worker, cx) })))
      .when(Boolean(dialog), element => element.child(dialog));
  }

  chat(failure) {
    const messages = this.snapshot?.messages ?? [];
    const { bot } = this.sandbox;
    const activity = this.snapshot?.bot.activity;
    const isUnanswered = activity === "offline" && !isFromBot(messages.at(-1));
    const waiting = this.isWaiting() || isUnanswered ? { activity, waitingSince: this.waitingSince || Date.now() } : null;
    const emptyText = this.snapshot ? `Ask ${bot} to start work.` : `Connecting to ${bot}…`;
    const answers = answersTo(messages, this.outbox);
    const below = message => this.secrets.render(message, bot) ?? this.questions.render(message, answers.get(message.id));
    return v_flex().flex_1().min_w(0).min_h(0).on_drop((event, cx) => this.composer.drop(event.paths, cx))
      .child(this.transcript.render({ bot, messages, outbox: this.outbox, below, waiting, emptyText, layoutKey: `${Boolean(failure)}:${this.composer.heightKey()}` }))
      .child(this.composer.render());
  }

  sections() {
    const { workers = [], trace = LOADING, routines = LOADING, children = LOADING, status = CONNECTING } = this.snapshot ?? {};
    const asking = workers.filter(worker => worker.dialog).length;
    return [
      { id: "workers", title: `Workers · ${workers.length}${asking ? ` · ${asking} asking` : ""}`, content: () => v_flex().w_full()
        .when(!workers.length, element => element.child(label(`Ask ${this.sandbox.bot} to delegate a task.`)))
        .children(workers.map(worker => this.workerRow(worker))) },
      { id: "wakes", title: "Recent wakes", content: () => wakeRows(trace) },
      { id: "routines", title: "Routines", content: () => note(routines) },
      { id: "children", title: "Pots children", content: () => note(children) },
      { id: "gateway", title: "Gateway", content: () => factRows(status) },
    ];
  }

  sidebar(sections, compact) {
    const frame = v_flex().id("pots-sidebar").min_h(0).px(16).overflow_y_scrollbar().border_color(theme().border);
    return (compact ? frame.w_full().h(COMPACT_SIDEBAR_PX).flex_none().border_t(1) : frame.w(SIDEBAR_PX).flex_none().border_l(1))
      .children(sections.map(({ title, content }) => section(title, content())));
  }

  render(openSections, compact) {
    const open = this.sections().filter(({ id }) => openSections.has(id));
    const failure = this.error || (this.connectionError && `${this.connectionError} Retrying.`);
    // A row centers its children by default: stretched, the chat and the sidebar get the height their scroll areas resolve against.
    return v_flex().id("pots-root").w_full().flex_1().min_w(0).min_h(0)
      .when(Boolean(failure), element => element.child(note(failure).p(12).text_color(theme().blocked)))
      .child((compact ? v_flex() : h_flex().items_stretch()).flex_1().min_h(0).min_w(0)
        .child(this.chat(failure)).when(open.length > 0, element => element.child(this.sidebar(open, compact))));
  }
}
