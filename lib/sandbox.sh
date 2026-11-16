POTS_REPO=$(cd "$(dirname "$0")/.." && pwd)
export POTS_REPO
POTS_RUNTIME=${POTS_RUNTIME:-$HOME/.config/agent-sandbox}
export POTS_RUNTIME
POTS_SANDBOX_ROOT="$POTS_RUNTIME/sandboxes"
POTS_SANDBOX_DIR="$POTS_SANDBOX_ROOT/${SANDBOX:-}"
POTS_CONFIG="$POTS_SANDBOX_DIR/sandbox.json"
if [ -z "${SANDBOX:-}" ] || [ ! -f "$POTS_CONFIG" ]; then
	echo "$(basename "$0"): set SANDBOX to one of: $(ls "$POTS_SANDBOX_ROOT" | tr '\n' ' ')" >&2
	exit 2
fi
. "$POTS_REPO/session/launch.env"
POTS_PROFILE=$SANDBOX
POTS_CONTEXT="colima-$POTS_PROFILE"
POTS_LAUNCHER=$(jq -r '.launcher // "docker"' "$POTS_CONFIG")
case "$POTS_LAUNCHER" in
	docker | sealskin) ;;
	*) echo "$(basename "$0"): launcher must be docker or sealskin in $POTS_CONFIG, got '$POTS_LAUNCHER'" >&2; exit 2 ;;
esac
POTS_SERVER_CONTAINER=sealskin
POTS_SERVER_USER=abc
POTS_SERVER_NETWORK=agent-sandbox_default
POTS_SERVER_PORT=$(jq -r '.serverPort // empty' "$POTS_CONFIG")
POTS_SERVER_URL=https://127.0.0.1:$POTS_SERVER_PORT
POTS_APP_ID=pots
POTS_HOME_NAME=pots
POTS_SEALSKIN_CONFIG=/config/.config/sealskin
POTS_SESSION_USER=abc
POTS_SESSION_HOME=/config

require_sealskin() {
	[ "$POTS_LAUNCHER" = sealskin ] || { echo "$(basename "$0"): sandbox $SANDBOX uses the docker launcher, which has no SealSkin server" >&2; exit 2; }
	[ -n "$POTS_SERVER_PORT" ] || { echo "$(basename "$0"): serverPort is missing in $POTS_CONFIG" >&2; exit 2; }
}

sandbox_docker() {
	docker --context "$POTS_CONTEXT" "$@"
}

session_exec() {
	input=
	if [ "$1" = --interactive ]; then
		input=--interactive
		shift
	fi
	container=$1
	shift
	sandbox_docker exec $input --user root "$container" s6-setuidgid "$POTS_SESSION_USER" env HOME="$POTS_SESSION_HOME" "$@"
}

SERVER_READY_ATTEMPTS=60

wait_for_server() {
	curl --silent --fail --insecure --output /dev/null --retry "$SERVER_READY_ATTEMPTS" --retry-delay 2 --retry-all-errors "$POTS_SERVER_URL/"
}

session_container() {
	sandbox_docker ps --filter "label=$POTS_SESSION_LABEL" --filter status=running --format '{{.Names}}' | head -1
}

running_session() {
	name=$(session_container)
	[ -n "$name" ] || { echo "$(basename "$0"): no running Pots session" >&2; return 1; }
	echo "$name"
}
