POTS_TOOLS="$HOME/.local"
POTS_GH="$POTS_TOOLS/libexec/gh"
# session/pots is the pots on PATH and hands upstream's commands to the package installed here.
POTS_UPSTREAM="$POTS_TOOLS/libexec/pots/bin/pots"
NPM_CONFIG_PREFIX="$POTS_TOOLS"
PATH="$POTS_TOOLS/bin:$POTS_TOOLS/node/bin:$PATH"
. "${POTS_REPO:-/opt/agent-sandbox}/session/launch.env"
POTS_ROUTER_ADDRESS=${POTS_ROUTER_ADDRESS:-$POTS_ROUTER_DEFAULT_ADDRESS}
POTS_ROUTER_API="http://$POTS_ROUTER_ADDRESS/v1"
# The router listens on loopback, where it accepts any key, and Pi offers its models only when this variable is set.
MAGPIE_API_KEY=magpie
export NPM_CONFIG_PREFIX PATH MAGPIE_API_KEY POTS_UPSTREAM

if [ -r "$POTS_RELEASE_ID" ]; then
	read -r POTS_LOADED_REVISION < "$POTS_RELEASE_ID"
	export POTS_LOADED_REVISION
fi
session_identity="$HOME/$POTS_SESSION_VAULT_DIRECTORY/$POTS_SESSION_VAULT_FILE"
if [ -f "$session_identity" ]; then
	while IFS='=' read -r name value; do
		case "$name" in
			INFISICAL_API_URL | INFISICAL_UNIVERSAL_AUTH_CLIENT_ID | INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET) export "$name=$value" ;;
			*) echo "session/lib.sh: unexpected session credential name; rerun bin/session-credentials" >&2; return 1 ;;
		esac
	done < "$session_identity"
fi
INFISICAL_MASK_SECRET_VALUES=true
export INFISICAL_MASK_SECRET_VALUES
unset name value session_identity

# session-bootstrap restarts each service once it has installed what the service runs.
idle_until_bootstrap() {
	echo "$1: waiting for bin/session-bootstrap" >&2
	exec sleep infinity
}
