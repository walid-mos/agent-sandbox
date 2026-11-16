const LINE_BREAK = "\n";

/** Herdr's Textarea breaks the line on every Enter before reporting the key, with no setting to send instead: this is the text from before that break. */
export function textBeforeEnter(before, after) {
  const shared = Math.min(before.length, after.length - LINE_BREAK.length);
  let start = 0;
  while (start < shared && before[start] === after[start]) start++;
  let end = 0;
  while (end < shared - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  return after.slice(start, after.length - end) === LINE_BREAK ? before : after;
}
