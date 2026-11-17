import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme } from "herdr";
import { TEXT, label, stopPress } from "./ui.js";
import { icon, solidButton } from "./pots-icons.js";
import { isFromBot } from "./pots-source.js";

// A multiple-choice answer names one picked label per line, so the bot reads the picks and the card finds them again.
// session/human-contract.mjs (isLabel) refuses a label with a line break for it, and session/pot/AGENTS.md tells the bot.
const PICK_SEPARATOR = "\n";
const OPTION_PX = 32;
const BOX_PX = 16;
const BOX_CHECK_PX = 12;
const ANSWERED_OPACITY = 0.55;
const SINGLE_HINT = "Pick one, or write your own answer below.";
const MULTIPLE_HINT = "Pick any, then Send. Or write your own answer below.";
const ANSWERED = "Answered";
const RECOMMENDED = "Recommended";

/** The answer to each question in the conversation: the text of the person's next message, else of their first message
 *  still on its way, else null. A message that failed or waits behind one that failed answers nothing, and neither do
 *  saved secrets, which reply to the bot's request for them. */
export function answersTo(messages, outbox) {
  const answers = new Map();
  const onItsWay = outbox.unshown(messages).find(item => outbox.isOnItsWay(item));
  let next = onItsWay?.draft.text ?? null;
  for (const message of messages.toReversed()) {
    if (message.question) { answers.set(message.id, next); next = null; }
    if (!isFromBot(message) && !message.isSecretReply) next = message.text;
  }
  return answers;
}

function checkBox(isChecked) {
  const colors = theme();
  return div().size(BOX_PX).flex_none().rounded(4).border_1().flex().items_center().justify_center()
    .border_color(isChecked ? colors.accent : colors.dim).bg(isChecked ? colors.accent : colors.background)
    .when(isChecked, element => element.child(icon("check", BOX_CHECK_PX).text_color(colors.accent_foreground)));
}

function optionText({ label: text, detail, recommended }) {
  const colors = theme();
  return v_flex().flex_1().min_w(0).gap(2)
    .child(h_flex().gap(8).items_center()
      .child(label(text, TEXT.body, colors.foreground).font_semibold())
      .when(recommended, element => element.child(label(RECOMMENDED, TEXT.micro, colors.accent))))
    .when(Boolean(detail), element => element.child(label(detail, TEXT.small, colors.muted)));
}

/**
 * The questions the bot asks with a `question` block, each option a button under its message. A pick leaves as the
 * person's own message, so the bot reads it as any answer, and a question with an answer on its way or arrived is shut.
 */
export class QuestionCards {
  constructor(answer) {
    this.answer = answer;
    this.picks = new Map();
    this.answers = new Map();
  }

  /** Picking a single option sends it at once, so a second click before the write lands finds the question shut. */
  choose(id, text, cx) {
    if (this.answers.has(id)) return;
    this.answers.set(id, text);
    this.answer(text, cx, id);
  }

  toggle(id, choice, cx) {
    const picked = new Set(this.picks.get(id));
    if (picked.has(choice)) picked.delete(choice);
    else picked.add(choice);
    this.picks.set(id, picked);
    cx.notify();
  }

  sendPicks(message, cx) {
    const picked = this.picks.get(message.id);
    if (!picked?.size) return;
    const text = message.question.options.map(option => option.label).filter(choice => picked.has(choice)).join(PICK_SEPARATOR);
    this.choose(message.id, text, cx);
  }

  optionButton(message, option, index, { isOpen, isPicked, isStacked }) {
    const colors = theme();
    const { id, question } = message;
    const choose = cx => (question.multiple ? this.toggle(id, option.label, cx) : this.choose(id, option.label, cx));
    return h_flex().id(`pots-question-${id}-${index}`).min_h(OPTION_PX).gap(10).px(12).py(6).items_center().rounded(8)
      .border_1().border_color(isPicked ? colors.accent : colors.border).bg(isPicked ? colors.selected : colors.background)
      .when(isStacked, element => element.w_full())
      .when(!isOpen && !isPicked, element => element.opacity(ANSWERED_OPACITY))
      .when(isOpen, element => element.cursor_pointer().hover(style => style.bg(colors.hover))
        .on_mouse_down("left", stopPress).on_click((_event, cx) => choose(cx)))
      .when(question.multiple, element => element.child(checkBox(isPicked)))
      .child(optionText(option))
      .when(!question.multiple && isPicked, element => element.child(icon("check").text_color(colors.accent)));
  }

  sendButton(message) {
    return solidButton({ id: `pots-question-send-${message.id}`, text: "Send", isEnabled: Boolean(this.picks.get(message.id)?.size),
      action: (_event, cx) => this.sendPicks(message, cx) });
  }

  /** The options under a message that asks a question, or null for any other message. `answer` is its entry in
   *  `answersTo`. */
  render(message, answer) {
    const { question } = message;
    if (!question) return null;
    const colors = theme();
    // A click answers at once, before its message reaches the outbox's view of what is on its way.
    const given = answer ?? this.answers.get(message.id) ?? null;
    const isOpen = given === null;
    if (!isOpen) this.picks.delete(message.id);
    const picked = isOpen ? this.picks.get(message.id) ?? new Set() : new Set(given.split(PICK_SEPARATOR));
    // Options without a detail are short enough to sit side by side, as a yes or no does.
    const isStacked = question.options.some(option => option.detail);
    const hint = !isOpen ? ANSWERED : question.multiple ? MULTIPLE_HINT : SINGLE_HINT;
    return v_flex().id(`pots-question-${message.id}`).w_full().gap(8)
      .child((isStacked ? v_flex() : h_flex().flex_wrap()).w_full().gap(6)
        .children(question.options.map((option, index) =>
          this.optionButton(message, option, index, { isOpen, isPicked: picked.has(option.label), isStacked }))))
      .child(h_flex().w_full().gap(10).items_center()
        .child(label(hint, TEXT.small, colors.muted).flex_1().min_w(0))
        .when(isOpen && question.multiple, element => element.child(this.sendButton(message))));
  }
}
