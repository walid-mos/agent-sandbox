import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme } from "herdr";
import { TEXT, label } from "./ui.js";
import { answerSecret, failureText } from "./pots-source.js";
import { icon, solidButton } from "./pots-icons.js";

const KEY_PX = 170;
// As tall as solidButton, so Save lines up beside the fields.
const FIELD_PX = 30;
const SKIP_HINT = "Leave empty to skip";

const asked = keys => (keys.length === 1 ? "a secret" : `${keys.length} secrets`);

/**
 * The bot's open requests for secrets, each drawn under its message with a masked input per key. The inputs keep the
 * values until they are saved, so a failed save can be retried, and no input holds them after.
 */
export class SecretForms {
  constructor(sandbox, { onAnswered, onFailed }) {
    this.sandbox = sandbox;
    this.onAnswered = onAnswered;
    this.onFailed = onFailed;
    this.forms = new Map();
  }

  /** InputState needs a live host call, so a request gets its inputs when a snapshot brings it, never while drawing. */
  sync(messages) {
    const open = messages.filter(message => message.secret);
    const openIds = new Set(open.map(message => message.id));
    [...this.forms.keys()].filter(id => !openIds.has(id)).forEach(id => this.close(id));
    open.filter(message => !this.forms.has(message.id)).forEach(message => this.forms.set(message.id, this.open(message)));
  }

  open({ id, secret }) {
    const inputs = secret.keys.map(key => {
      const state = InputState.new({ placeholder: SKIP_HINT });
      state.set_masked(true);
      return { key, state };
    });
    inputs.forEach(({ state }, index) => state.on("submit", (_event, cx) => {
      const next = inputs[index + 1];
      if (next) next.state.focus();
      else this.submit(id, cx);
    }));
    return { inputs, state: "open", error: "" };
  }

  close(id) {
    this.forms.get(id).inputs.forEach(({ state }) => { state.set_value(""); state.release(); });
    this.forms.delete(id);
  }

  /** A saved answer stays until a snapshot shows it, so the bot owes a reply from the moment it is saved. */
  isAwaitingReply() { return [...this.forms.values()].some(form => form.state === "saved"); }

  update(id, change) {
    if (this.forms.has(id)) this.forms.set(id, { ...this.forms.get(id), ...change });
  }

  submit(id, cx) {
    const form = this.forms.get(id);
    if (form?.state !== "open") return;
    const values = Object.fromEntries(form.inputs.map(({ key, state }) => [key, state.value()]));
    this.update(id, { state: "saving", error: "" });
    cx.notify();
    cx.spawn(async cx => {
      try {
        await answerSecret(this.sandbox, id, values);
        this.forms.get(id)?.inputs.forEach(({ state }) => state.set_value(""));
        this.update(id, { state: "saved" });
        this.onAnswered(cx);
      }
      catch (error) {
        this.update(id, { state: "open", error: failureText(error, "The secrets could not be saved.") });
        // The answer may have arrived with only its reply lost: the next snapshot then closes the card.
        this.onFailed(cx);
      }
      cx.notify();
    });
  }

  field({ key, state }) {
    const colors = theme();
    return h_flex().w_full().gap(10).items_center()
      .child(label(key, TEXT.small, colors.foreground).w(KEY_PX).flex_none().truncate())
      .child(Input.new(state).flex_1().min_w(0).h(FIELD_PX).px(10).rounded(8).border_1().border_color(colors.border)
        .bg(colors.background).text_size(TEXT.body).text_color(colors.foreground));
  }

  saveButton(id, form) {
    const isOpen = form.state === "open";
    return solidButton({ id: `pots-secret-save-${id}`, text: isOpen ? "Save" : "Saving…", isEnabled: isOpen, action: (_event, cx) => this.submit(id, cx) });
  }

  /** The form under an open request, or null once it has its answer. */
  render({ id, secret }, bot) {
    const form = this.forms.get(id);
    if (!form || form.state === "saved") return null;
    const colors = theme();
    return v_flex().id(`pots-secret-${id}`).w_full().gap(10).p(14).rounded(12).border_1().border_color(colors.border).bg(colors.surface)
      .child(h_flex().gap(8).items_center().child(icon("key-round").text_color(colors.accent))
        .child(label(`${bot} asks for ${asked(secret.keys)}`, TEXT.body, colors.foreground).font_semibold()))
      .child(label(`What you type stays hidden and goes only to ${secret.file} in Pots' secrets folder. ${bot} learns which keys came, never their values.`, TEXT.small, colors.muted))
      .children(form.inputs.map(input => this.field(input)))
      .child(h_flex().w_full().gap(10).items_center()
        .child(label(form.error, TEXT.small, colors.blocked).flex_1().min_w(0))
        .child(this.saveButton(id, form)));
  }
}
