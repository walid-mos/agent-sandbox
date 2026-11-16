import { appHome, layout, readTextFile, shared, writeTextFile } from "herdr";

const RELOAD_POLL_MS = 100;
const RELOAD_LIMIT_MS = 5000;

let queue = Promise.resolve();

// layout.set takes the whole tree as a host argument, and the host refuses arguments nested deeper than 16 levels, which Command Center's layout already is.
async function writeTree(tree) {
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  const current = await readTextFile(path);
  if (current === null) throw new Error(`Herdr has no layout file at ${path}. Switch to a layout saved in layouts/ and try again.`);
  await writeTextFile(path, `${JSON.stringify(tree, null, 2)}\n`, current);
}

async function waitForReload(isApplied, cx) {
  for (let waited = 0; waited < RELOAD_LIMIT_MS; waited += RELOAD_POLL_MS) {
    if (isApplied(layout())) return;
    await cx.sleep(RELOAD_POLL_MS);
  }
  throw new Error("Herdr did not load the updated layout within 5 s. Check herdr-app status for a layout error.");
}

async function apply(transform, isApplied, cx) {
  const current = layout();
  const tree = transform(current);
  if (tree === current) return;
  await writeTree(tree);
  await waitForReload(isApplied, cx);
}

export function commitLayout(transform, isApplied, cx) {
  const task = queue.then(() => apply(transform, isApplied, cx));
  queue = task.catch(() => {});
  return task;
}
