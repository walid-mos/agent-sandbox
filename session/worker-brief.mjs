import { join } from 'node:path';
import { idleStackMinutes } from './limits.mjs';
import { sandbox } from './sandbox.mjs';

const CLEAN_PASS_GUIDE = join(import.meta.dirname, 'clean-pass.md');

export function repositoryBrief(worker) {
  const publication = worker.publication === 'local'
    ? `This worker exists locally and has no PR. Never push or open its first PR yourself. Ask ${sandbox.bot} to run dispatch scope ${worker.name}, register a new exact commit-ID push question, then dispatch publish ${worker.name} with its checked dialog ID and affirmative label. Local work and send never consume approval. A prior bootstrap-only startup dialog cannot cover this existing worker. Read /opt/agent-sandbox/docs/worker-delegation.md before publication.`
    : `Draft PR: ${worker.pullRequest}.`;
  return `${worker.request}\n\nWork only in ${worker.worktree}, branch ${worker.branch}. ${publication} Use the installed Pi harness and its skills. This checkout already is this task's worktree; do not hand it off again. The only agents you start are the passes of the clean pass. Before your first implementation commit, install the dependencies as the repository documents and the loaded rules allow. Check the empty bootstrap commit against the repository's commit rules and report a mismatch instead of rewriting a pushed commit. Commit atomically in the repository's own format. When no terminal runs here for ${idleStackMinutes} minutes, the Pots watcher stops its Compose projects and keeps their volumes. Start a stopped one with docker compose start. Push only as the loaded rules allow. When a push waits for the person's yes, report the branch, remote and full waiting commit IDs to ${sandbox.bot} for one checked approval. Before your final response, read ${CLEAN_PASS_GUIDE}, run any required clean pass, and mark the PR ready only when that guide permits it. Report the PR, checks, commit, unpushed commits and uncommitted paths. The watcher relays completion to ${sandbox.bot}.\n`;
}

export function taskBrief(worker) {
  return `${worker.request}\n\nThis is a non-repository task. Work only in ${worker.worktree}. Scope: ${worker.scope}\nWrite the bounded result to ${worker.resultFile}, then report that path and the evidence for your conclusions. Use the installed Pi harness and its skills. Do not create a worktree, branch, commit or PR, or push. If the need becomes repository work, report it to ${sandbox.bot} as an explicit new repository task under its loaded approval rules. A follow-up cannot convert this task into a repository worker. Start no other agents. The watcher keeps your result and relays completion to ${sandbox.bot}.\n`;
}
