// Another process appends while this reads, so a line that does not parse is skipped.
export function parsedLine(line) {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
}
