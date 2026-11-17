import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme } from "herdr";
import { TEXT, label, stopPress } from "./ui.js";
import { answerDialog, failureText } from "./pots-source.js";
import { icon } from "./pots-icons.js";

const MARK_PX = 14;
const CHECK_PX = 10;
const FIELD_PX = 28;
const RECEIPT_MS = 60000;
const OWN_ANSWER = "Write your own answer";

const placeholder = question => {
  if (!question.options.length) return "Your answer";
  return question.isMultiple ? "Add your own answer (optional)" : "Your own answer";
};

/** A free answer counts for an open question, for any multiple choice, and for a single choice once its own answer is picked. */
const isTyped = (question, answer) => question.isMultiple || answer.isOwn;

const toggled = (choices, index) => choices.includes(index) ? choices.filter(choice => choice !== index) : [...choices, index];

/**
 * The question a blocked worker shows in its terminal, drawn under its row. The answer goes to that dialog itself,
 * and what the worker received stays under the row for a minute.
 */
export class WorkerDialogs {
  constructor(sandbox, onAnswered) {
    this.sandbox = sandbox;
    this.onAnswered = onAnswered;
    this.forms = new Map();
    this.receipts = new Map();
  }

  /** InputState needs a live host call, so a question gets its inputs when a snapshot brings it, never while drawing.
   *  A snapshot taken before an answer landed still shows the answered question, so its receipt keeps it closed. */
  sync(workers) {
    const asked = new Map(workers.filter(worker => worker.dialog?.kind === "question").map(worker => [worker.name, worker.dialog]));
    [...this.forms].filter(([name, form]) => asked.get(name)?.id !== form.dialog.id).forEach(([name]) => this.close(name));
    [...this.receipts].filter(([, receipt]) => Date.now() - receipt.at > RECEIPT_MS).forEach(([name]) => this.receipts.delete(name));
    asked.forEach((dialog, name) => {
      if (!this.forms.has(name) && this.receipts.get(name)?.dialogId !== dialog.id) this.forms.set(name, this.open(name, dialog));
    });
  }

  open(name, dialog) {
    const answers = dialog.questions.map(question => {
      const input = InputState.new({ placeholder: placeholder(question) });
      input.on("submit", (_event, cx) => this.submit(name, cx));
      return { choices: [], isOwn: !question.options.length, input };
    });
    return { dialog, answers, state: "open", error: "" };
  }

  close(name) {
    this.forms.get(name).answers.forEach(({ input }) => input.release());
    this.forms.delete(name);
  }

  update(name, change) {
    if (this.forms.has(name)) this.forms.set(name, { ...this.forms.get(name), ...change });
  }

  choose(name, questionIndex, change, cx) {
    const form = this.forms.get(name);
    if (form?.state !== "open") return;
    this.update(name, { answers: form.answers.map((answer, index) => (index === questionIndex ? { ...answer, ...change(answer) } : answer)) });
    cx.notify();
  }

  pick(name, questionIndex, optionIndex, cx) {
    const isMultiple = this.forms.get(name)?.dialog.questions[questionIndex].isMultiple;
    this.choose(name, questionIndex, answer => (isMultiple ? { choices: toggled(answer.choices, optionIndex) } : { choices: [optionIndex], isOwn: false }), cx);
  }

  pickOwn(name, questionIndex, cx) {
    this.choose(name, questionIndex, () => ({ choices: [], isOwn: true }), cx);
    this.forms.get(name)?.answers[questionIndex].input.focus();
  }

  submit(name, cx) {
    const form = this.forms.get(name);
    if (form?.state !== "open") return;
    const answers = form.answers.map((answer, index) => ({
      choices: answer.choices, text: isTyped(form.dialog.questions[index], answer) ? answer.input.value() : "",
    }));
    this.update(name, { state: "sending", error: "" });
    cx.notify();
    // A snapshot may have replaced this form with the worker's next question while the answer settled.
    const isCurrent = () => this.forms.get(name)?.dialog.id === form.dialog.id;
    cx.spawn(async cx => {
      try {
        const text = await answerDialog(this.sandbox, name, form.dialog.id, answers);
        this.receipts.set(name, { dialogId: form.dialog.id, text, at: Date.now() });
        if (isCurrent()) this.close(name);
        this.onAnswered(cx);
      }
      catch (error) { if (isCurrent()) this.update(name, { state: "open", error: failureText(error, "The answer did not reach the worker.") }); }
      cx.notify();
    });
  }

  mark(isOn, isMultiple) {
    const colors = theme();
    return div().size(MARK_PX).mt(2).flex_none().flex().items_center().justify_center().border_1()
      .border_color(isOn ? colors.accent : colors.dim).bg(isOn ? colors.accent : colors.background)
      .when(isMultiple, element => element.rounded(4)).when(!isMultiple, element => element.rounded_full())
      .when(isOn, element => element.text_color(colors.accent_foreground).child(icon("check", CHECK_PX)));
  }

  optionRow({ id, text, detail = "", isRecommended = false, isOn, isMultiple, action }) {
    const colors = theme();
    return h_flex().id(id).w_full().gap(8).px(6).py(4).items_start().rounded(6).cursor_pointer()
      .hover(style => style.bg(colors.hover)).on_mouse_down("left", stopPress).on_click(action)
      .child(this.mark(isOn, isMultiple))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().w_full().gap(6).items_center()
          .child(div().min_w(0).text_size(TEXT.small).text_color(colors.foreground).child(text))
          .when(isRecommended, element => element.child(label("Recommended", TEXT.micro, colors.accent).flex_none())))
        .when(Boolean(detail), element => element.child(div().w_full().text_size(TEXT.micro).text_color(colors.dim).child(detail))));
  }

  field(input) {
    const colors = theme();
    return Input.new(input).w_full().h(FIELD_PX).px(8).rounded(6).border_1().border_color(colors.border)
      .bg(colors.background).text_size(TEXT.small).text_color(colors.foreground);
  }

  question(name, form, question, index) {
    const colors = theme();
    const answer = form.answers[index];
    const key = `pots-dialog-${name}-${index}`;
    return v_flex().w_full().gap(4)
      .child(div().w_full().text_size(TEXT.small).text_color(colors.foreground).font_semibold().child(question.prompt))
      .when(question.isMultiple, element => element.child(label("Choose any that apply", TEXT.micro, colors.dim)))
      .children(question.options.map((option, optionIndex) => this.optionRow({
        id: `${key}-${optionIndex}`, text: option.label, detail: option.description, isRecommended: option.isRecommended,
        isOn: answer.choices.includes(optionIndex), isMultiple: question.isMultiple,
        action: (_event, cx) => this.pick(name, index, optionIndex, cx),
      })))
      .when(question.options.length > 0 && !question.isMultiple, element => element.child(this.optionRow({
        id: `${key}-own`, text: OWN_ANSWER, isOn: answer.isOwn, isMultiple: false, action: (_event, cx) => this.pickOwn(name, index, cx),
      })))
      .when(isTyped(question, answer), element => element.child(this.field(answer.input)));
  }

  answerButton(name, form) {
    const colors = theme();
    const isOpen = form.state === "open";
    return h_flex().id(`pots-dialog-answer-${name}`).h(FIELD_PX).px(12).flex_none().items_center().rounded(6)
      .bg(isOpen ? colors.solid : colors.hover).text_color(isOpen ? colors.solid_foreground : colors.dim)
      .when(isOpen, element => element.cursor_pointer().on_mouse_down("left", stopPress).on_click((_event, cx) => this.submit(name, cx)))
      .child(div().text_size(TEXT.small).font_semibold().child(isOpen ? "Answer" : "Sending…"));
  }

  card(name, form) {
    const colors = theme();
    return v_flex().id(`pots-dialog-${name}`).w_full().gap(10).p(10).rounded(10).border_1().border_color(colors.border).bg(colors.surface)
      .child(label("Your answer goes to the question in its terminal.", TEXT.micro, colors.muted))
      .children(form.dialog.questions.map((question, index) => this.question(name, form, question, index)))
      .child(h_flex().w_full().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(TEXT.micro).text_color(colors.blocked).child(form.error))
        .child(this.answerButton(name, form)));
  }

  /** What goes under a worker's row: its question, a note on a dialog only its terminal answers, what it received, or null. */
  render(worker) {
    const colors = theme();
    const receipt = this.receipts.get(worker.name);
    const form = this.forms.get(worker.name);
    const notice = text => div().w_full().text_size(TEXT.small).text_color(colors.muted).child(text);
    if (form) return this.card(worker.name, form);
    if (receipt && (!worker.dialog || worker.dialog.id === receipt.dialogId)) return notice(`Answered. ${receipt.text}`);
    if (worker.dialog?.kind === "closed") return notice(worker.dialog.message);
    if (worker.dialog?.kind === "answered") return notice(`Answered. ${worker.dialog.message}`);
    if (worker.dialog?.kind === "resumed") return notice("Asks again a question you began in its terminal. Open it to finish there.");
    if (worker.dialog?.kind === "secret") return notice(`Open its terminal to type the secret it asks for: ${worker.dialog.purpose}`);
    if (worker.dialog?.kind === "other") return notice(`Waits for you in its terminal${worker.dialog.message ? `: ${worker.dialog.message}` : ""}. Open it to answer.`);
    return null;
  }
}
