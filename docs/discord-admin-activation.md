# Activate Discord Admin in Mastermind

Discord Admin uses the [registered bot activation path](bot-activation.md). This page covers its provider rollout and live owner check.

## Deployment boundary

1. From the configured provider checkout, verify the operator-signed tip containing this change in the VM with its installed trusted launcher. Identify Mastermind's existing session with `SANDBOX=mastermind ./bin/pots-session name` and verify the full container ID, start time and read-only directory mounts. Record gateway, router, approval service, Pi and worker PIDs and start times, and worker and terminal IDs. Check that the installed Pots CLI supports hot `bot new` and that the gateway and router are healthy.
2. Stage `"botActivation": {"discord-admin": true}` in Mastermind's private bundle and apply `SANDBOX=mastermind ./bin/vm-config`. Check the full bundle diff before transfer because the command replaces the bundle and removes omitted optional files. Read back the opt-in in the same session through `bin/sandbox-exec`.
3. If the running `pots-discord-human` predates the registered bot activation verifier, run `docker exec --user root VERIFIED_CONTAINER_ID s6-svc -r /run/service/custom-svc-pots-discord-human` through the configured provider Docker transport. This is the [targeted restart used by session bootstrap](../lib/sandbox.sh). The old Node process keeps its startup imports and SQLite query after a signed source update. Check the new service PID and start time against the signed rollout. Compare the other recorded process and session identities. This provider step needs the private bundle, VM transport, trusted launcher and provider Docker access.

## Activate from Mastermind's session

Use `node /opt/agent-sandbox/session/bot-activate.mjs discord-admin` with the modes below. The CLI runs as Mastermind's session user.

1. Run `prepare`, post the returned `message` through the existing shared application with its controls disabled, and run `register` with `{"dialog":"DIALOG_ID","messages":[{"channelId":"CHANNEL_ID","messageId":"MESSAGE_ID"}]}` on stdin. Enable the exact controls only after the command returns `registered: true` and `state: "acknowledged"`.
2. For the installed approval check, have the guild owner choose `Cancel` on this fresh registration. Confirm that the service wakes Mastermind and that `apply DIALOG_ID` returns `declined`. Check the saved registration, checked owner click, message update and consumed cancellation in Mastermind's dialog store. Compare the recorded handler PID and verifier revision with the installed service and confirm the bot is absent. A stale handler, prose report or click from an ordinary dialog supplies no activation authority.
3. After that proof, prepare a fresh question for the owner to decide. On approval, run `apply DIALOG_ID` in the same session. The command checks the current owner and exact registered click, saves consumption, installs the fixed bot and checks that the original gateway reports it running. Verify `status`, `pots bot list`, `pots status`, the signed links and `node /opt/agent-sandbox/session/discord-admin.mjs actions`. Compare the process and terminal identities captured before rollout. Use a harmless `pots chat --bot discord-admin` readback to verify delegation before assigning administration. Mastermind reports its evidence through the door.

| Failure | Recovery |
| --- | --- |
| Stale handler, wrong owner or changed display | Restore the checked service or display and register a fresh question. |
| Discord unavailable | Restore Discord access before retrying. The command checks the current guild, application and owner before consuming or resuming. |
| Interrupted installation or Pots unavailable | Check the original gateway and bot home, then rerun `apply` with the same consumed approval. The receipt stays single-use and installation resumes from the existing fixed bot home. A conflicting or incomplete bot definition requires owner inspection. |
| Completion already saved | `apply` reports `already_active`. Use the installed status checks to verify current health. |
