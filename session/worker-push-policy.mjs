import { join } from 'node:path';

export const PUSH_POLICY_GUIDE = join(import.meta.dirname, '../docs/human-dialogs.md');

export const workerPushPolicy = `Before any publication decision, read and apply ${PUSH_POLICY_GUIDE} under "When to ask for push approval". Use the current sandbox configuration and its configured client rules. Use this current policy for push approval decisions when the saved conversation contains older instructions. Keep any separate repository, branch, release and first-publication requirements.`;
