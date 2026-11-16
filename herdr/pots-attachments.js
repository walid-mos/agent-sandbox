import { exec, appHome } from "herdr";

// Herdr draws an image only from its own folder, so a file stays there for a week and its message shows it.
const FOLDER = "data/pots/attachments";
// hc carries at most this much to a sandbox on standard input.
const MAX_MEGABYTES = 8;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const DRAWN = /\.(png|jpe?g|gif|webp)$/i;
const EXTENSION = /\.[a-z0-9]+$/i;
const PASTED_NAME = "pasted-image.png";
const STAGE = 'mkdir -p "$1" && find "$1" -type f -mtime +7 -delete && cp "$2" "$1/$3" && wc -c < "$1/$3"';
const PASTE = 'mkdir -p "$1" && exec osascript -e "$2" "$1/$3"';
// A file copied in Finder also carries its icon as an image, so the file is looked for first.
const CLIPBOARD = `on run {target}
  try
    return POSIX path of (the clipboard as «class furl»)
  end try
  set copied to the clipboard as «class PNGf»
  set output to open for access POSIX file target with write permission
  set eof output to 0
  write copied to output
  close access output
  return target
end run`;
// The chooser belongs to osascript, which comes to the front so the dialog does not open behind Herdr.
const CHOOSER = `activate
set chosen to choose file with prompt "Attach to the message" with multiple selections allowed
set paths to {}
repeat with picked in chosen
  set end of paths to POSIX path of picked
end repeat
set AppleScript's text item delimiters to linefeed
return paths as text`;
const CANCELLED = "(-128)";

let staged = 0;

const folder = () => `${appHome()}/${FOLDER}`;

async function output(command, arguments_, failure) {
  const result = await exec(command, arguments_);
  if (result.code !== 0) throw new Error(failure);
  return result.stdout.trim();
}

export const unstage = attachment => exec("rm", ["-f", attachment.path]);

export async function stageFile(path) {
  const name = path.split("/").at(-1);
  const stored = `${Date.now()}-${++staged}${EXTENSION.exec(name)?.[0] ?? ""}`;
  const bytes = Number(await output("sh", ["-c", STAGE, "sh", folder(), path, stored], `${name} could not be read.`));
  const attachment = { id: stored, name, path: `${folder()}/${stored}`, preview: DRAWN.test(name) ? `${FOLDER}/${stored}` : null };
  if (bytes <= MAX_MEGABYTES * BYTES_PER_MEGABYTE) return attachment;
  await unstage(attachment);
  throw new Error(`${name} is over ${MAX_MEGABYTES} MB, the most a message can carry.`);
}

/** Herdr gives a mod no file chooser, so AppleScript opens the Mac's. Closing it chooses nothing. */
export async function chooseFiles() {
  const result = await exec("osascript", ["-e", CHOOSER]);
  if (result.code === 0) return result.stdout.split("\n").filter(Boolean);
  if (result.stderr.includes(CANCELLED)) return [];
  throw new Error(`The file chooser did not open. ${result.stderr.trim()}`);
}

/** Herdr gives a mod the clipboard's text only, so AppleScript reads a copied image or file. */
export async function stageClipboard() {
  return stageFile(await output("sh", ["-c", PASTE, "sh", folder(), CLIPBOARD, PASTED_NAME], "The clipboard holds no image or file to attach."));
}
