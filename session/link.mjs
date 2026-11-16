import { existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export function link(source, target) {
  if (!existsSync(source)) throw new Error(`${source} is missing in the session. Check the path and the session's mounts, then run bootstrap again.`);
  rmSync(target, { force: true });
  symlinkSync(source, target);
}

export function linkFolder(source, target) {
  for (const file of readdirSync(source)) link(join(source, file), join(target, file));
}
