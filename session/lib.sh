POTS_TOOLS="$HOME/.local"
POTS_GH="$POTS_TOOLS/libexec/gh"
# session/pots is the pots on PATH and hands upstream's commands to the package installed here.
POTS_UPSTREAM="$POTS_TOOLS/libexec/pots/bin/pots"
NPM_CONFIG_PREFIX="$POTS_TOOLS"
PATH="$POTS_TOOLS/bin:$POTS_TOOLS/node/bin:$PATH"
POTS_ROUTER_ADDRESS=${POTS_ROUTER_ADDRESS:-127.0.0.1:3425}
POTS_ROUTER_API="http://$POTS_ROUTER_ADDRESS/v1"
# The router listens on loopback, where it accepts any key, and Pi offers its models only when this variable is set.
MAGPIE_API_KEY=magpie
export NPM_CONFIG_PREFIX PATH MAGPIE_API_KEY POTS_UPSTREAM

# session-bootstrap restarts each service once it has installed what the service runs.
idle_until_bootstrap() {
	echo "$1: waiting for bin/session-bootstrap" >&2
	exec sleep infinity
}
