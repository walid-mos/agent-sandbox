import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme } from "herdr";
import { TEXT, label, elapsed } from "./ui.js";

const COLUMN_GAP = /\s{2,}/;
const WAKE_STAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const WAKE_TAIL_FIELDS = 2;
const FACT = /^([a-z][\w -]*): (.+)$/i;
const FACT_NAME_PX = 62;

const lines = value => value.split("\n").filter(line => line.trim());
const heading = title => label(title, TEXT.small).font_semibold();

export const note = value => div().w_full().min_w(0).text_size(TEXT.small).text_color(theme().foreground).child(value);

export function section(title, content) {
  return v_flex().w_full().flex_none().gap(8).py(14).border_b(1).border_color(theme().border)
    .child(heading(title)).child(content);
}

/** `pots trace` prints columns two or more spaces apart: the UTC time, the kind, what woke the bot, optional counts and model use, then the duration and the wake's id. */
function parseWake(line) {
  const [stamp, kind, source, ...rest] = line.trim().split(COLUMN_GAP);
  const time = WAKE_STAMP.exec(stamp);
  if (!time || rest.length < WAKE_TAIL_FIELDS) return null;
  return {
    id: rest.at(-1), at: Date.parse(`${time[1]}T${time[2]}Z`), kind, source,
    duration: rest.at(-WAKE_TAIL_FIELDS), details: rest.slice(0, -WAKE_TAIL_FIELDS).join(" · "),
  };
}

function wakeRow(wake) {
  const colors = theme();
  return v_flex().id(`pots-wake-${wake.id}`).w_full().flex_none().gap(2).py(5)
    .child(h_flex().w_full().gap(8)
      .child(label(`${wake.kind} · ${wake.source}`, TEXT.small, colors.foreground).flex_1())
      .child(label(wake.duration, TEXT.micro, colors.muted).flex_none())
      .child(label(elapsed(wake.at), TEXT.micro, colors.dim).flex_none()))
    .when(Boolean(wake.details), element => element.child(label(wake.details, TEXT.micro, colors.dim)));
}

/** Newest wake first. A line that is no wake, such as the totals or an error, stays as text under them. */
export function wakeRows(trace) {
  const parsed = lines(trace).map(line => ({ line, wake: parseWake(line) }));
  const rest = parsed.filter(item => !item.wake).map(item => item.line);
  return v_flex().w_full()
    .children(parsed.filter(item => item.wake).reverse().map(item => wakeRow(item.wake)))
    .when(rest.length > 0, element => element.child(
      div().w_full().pt(4).text_size(TEXT.micro).text_color(theme().dim).child(rest.join("\n"))));
}

function factRow(line, index) {
  const fact = FACT.exec(line);
  if (!fact) return note(line);
  return h_flex().id(`pots-fact-${index}`).w_full().gap(8).items_start()
    .child(label(fact[1], TEXT.small, theme().dim).w(FACT_NAME_PX).flex_none())
    .child(note(fact[2]).flex_1());
}

/** `pots status` prints one `name: value` line per fact. */
export function factRows(status) {
  return v_flex().w_full().gap(5).children(lines(status).map(factRow));
}
