# Clean pass

A task that builds a feature or changes a lot of code owes a clean pass before its pull request leaves draft. A fix of a few lines, a docs or config change and a throwaway repository skip it. When you skip it, say so and why in your final response.

Run it once your code is committed and the project's checks pass. A pass is Claude Code running the real command in its own terminal, in your worktree, on the person's Claude account. Write nothing while a pass runs.

```sh
node "$AGENT_SANDBOX_REPO/session/clean-pass.mjs" untangle AREA
node "$AGENT_SANDBOX_REPO/session/clean-pass.mjs" review
node "$AGENT_SANDBOX_REPO/session/clean-pass.mjs" simplify
```

1. Start `untangle` from your worktree, with the area your task touched. The command prints the pass's terminal.
2. `hc wait` that terminal until it stops, then `hc read` what it reports. A pass that stops on a question for the person has finished its work. Keep the question for your final response and answer nothing in its place.
3. Merge the `refactor/untangle-*` branch the pass left into your branch with `git merge --no-ff`.
4. Close the terminal with `hc kill`, then run `review` and then `simplify` the same way, one at a time. Commit what each one changed.
5. Run the project's checks and your own proof again on the result.

The clean pass is done when the three passes have reported, the untangle branch is merged, and the checks pass on your last commit. Your final response names that commit, what each pass reported in one line, and the question the untangle pass ended on.

A pass that cannot start names what to correct. A pass that stops because the Claude account has no quota left is not done. Say so in your final response and leave the pull request in draft.

## Ready for review

Your pull request opens as a draft. Mark it ready with `gh pr ready PULL_REQUEST` once the work is finished and tested: every change committed and pushed, the project's checks passing on your last commit, and the clean pass done or skipped under its exception. In a repository with the `factory` topic, the PR factory then checks, judges and merges it with no other review.

Keep it in draft while the work center that started you holds it, until a message from it lifts the hold, and while a push waits for the person's yes. Name the hold or the waiting push in your final response.
