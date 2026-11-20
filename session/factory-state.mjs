import { join } from 'node:path';
import { openJobs } from './factory-jobs.mjs';
import { FACTORY_HOME } from './factory-records.mjs';

export const JOB_DIRECTORY = join(FACTORY_HOME, 'execution');

export async function withJobs(operation) {
  const jobs = openJobs(JOB_DIRECTORY);
  try {
    return await operation(jobs);
  } finally {
    jobs.close();
  }
}

export function requireCurrent(jobs, record) {
  if (jobs.current(record) !== record.generation) {
    throw new Error('factory: use the wake for the current review generation');
  }
}
