POTS_REPO=$(cd "$(dirname "$0")/.." && pwd)
export POTS_REPO
MAC_ROUTER_PORT=3425
. "$POTS_REPO/session/launch.env"
# POTS_TRANSPORT=local marks a command running inside the sandbox VM, which holds its one sandbox's configuration at the session's path, so it needs neither SANDBOX nor HOME, which a systemd unit lacks.
case "${POTS_TRANSPORT:=provider}" in
	provider)
		POTS_RUNTIME=${POTS_RUNTIME:-$HOME/.config/agent-sandbox}
		export POTS_RUNTIME
		POTS_SANDBOX_ROOT="$POTS_RUNTIME/sandboxes"
		POTS_SANDBOX_DIR="$POTS_SANDBOX_ROOT/${SANDBOX:-}"
		;;
	local) POTS_SANDBOX_DIR=$POTS_SESSION_CONFIGURATION ;;
	*) echo "$(basename "$0"): POTS_TRANSPORT must be local or unset, got '$POTS_TRANSPORT'" >&2; exit 2 ;;
esac
export POTS_TRANSPORT
POTS_CONFIG="$POTS_SANDBOX_DIR/sandbox.json"
if [ "$POTS_TRANSPORT" = local ] && [ ! -f "$POTS_CONFIG" ]; then
	echo "$(basename "$0"): $POTS_CONFIG is missing. Run bin/vm-up for this sandbox from the operator's checkout." >&2
	exit 2
fi
if [ "$POTS_TRANSPORT" = provider ] && { [ -z "${SANDBOX:-}" ] || [ ! -f "$POTS_CONFIG" ]; }; then
	echo "$(basename "$0"): set SANDBOX to one of: $(ls "$POTS_SANDBOX_ROOT" | tr '\n' ' ')" >&2
	exit 2
fi

sandbox_provider() {
	jq -r '.provider // "colima"' "$1"
}

sandbox_doors() {
	jq -r '.doors // {} | keys | if all(test("^[a-z0-9-]+$")) then join(" ") else error("doors must name pots") end' "$POTS_CONFIG"
}

POTS_PROVIDER=$(sandbox_provider "$POTS_CONFIG")
case "$POTS_PROVIDER" in
	colima | proxmox) ;;
	*) echo "$(basename "$0"): provider must be colima or proxmox in $POTS_CONFIG, got '$POTS_PROVIDER'" >&2; exit 2 ;;
esac
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
	[ "$POTS_LAUNCHER" = sealskin ] || { echo "$(basename "$0"): sandbox ${SANDBOX:-of this VM} uses the docker launcher, which has no SealSkin server" >&2; exit 2; }
	[ -n "$POTS_SERVER_PORT" ] || { echo "$(basename "$0"): serverPort is missing in $POTS_CONFIG" >&2; exit 2; }
}

vm_setting() {
	value=$(jq -r --arg key "$1" '.vm[$key] // empty' "$POTS_CONFIG")
	case "$value" in
		'' | *[!0-9]*) echo "$(basename "$0"): vm.$1 must be a whole number in $POTS_CONFIG, got '$value'" >&2; exit 2 ;;
	esac
	echo "$value"
}

# A provider defines sandbox_vm, sandbox_docker, vm_is_running, vm_start and vm_forbidden_endpoints for its kind of VM.
if [ "$POTS_TRANSPORT" = local ]; then
	. "$POTS_REPO/lib/providers/local.sh"
else
	. "$POTS_REPO/lib/providers/$POTS_PROVIDER.sh"
fi

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

restart_services() {
	container=$1
	shift
	for service in "$@"; do
		sandbox_docker exec --user root "$container" s6-svc -r "/run/service/custom-svc-$service"
	done
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
