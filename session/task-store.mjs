import { existsSync, readdirSync } from 'node:fs';
import { underFileLock } from './file-lock.mjs';
import { join } from 'node:path';
import { readJson, writePrivateJson } from './private-json.mjs';
import { TERMINAL } from './terminal-conversation.mjs';

export const TASKS = join(TERMINAL, 'tasks');
export const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$/;

export function taskPath(id) {
  if (typeof id !== 'string' || !TASK_ID.test(id)) throw new Error('task: use an ID of 1-96 letters, digits, dots or hyphens.');
  return join(TASKS, `${id}.json`);
}

export function task(id) {
  const record = readJson(taskPath(id));
  if (!record) throw new Error('task: unknown identity. Submit it to this pot first.');
  return record;
}

export const saveTask = record => writePrivateJson(taskPath(record.id), record);
export const hasTask = id => existsSync(taskPath(id));
export const tasks = () => existsSync(TASKS) ? readdirSync(TASKS).filter(name => name.endsWith('.json')).map(name => task(name.slice(0, -5))) : [];

export const taskLock = operation => underFileLock(join(TASKS, '.lock'), operation);
