TAILSCALE_VERSION=1.104.7
TAILSCALE_RELEASES=https://pkgs.tailscale.com/stable
TAILSCALE_SHA256_amd64=e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c
TAILSCALE_SHA256_arm64=d6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484
# The keeper's bootstrap makes at most two of these downloads inside its 15-minute TimeoutStartSec.
DOWNLOAD_MAX_SECONDS=240

tailscale_is_current() {
	[ "$("$1" version 2> /dev/null | head -1)" = "$TAILSCALE_VERSION" ] &&
		[ "$("$2" --version 2> /dev/null | head -1)" = "$TAILSCALE_VERSION" ]
}

tailscale_unpack() {
	tailscale_architecture=$1 tailscale_directory=$2
	case "$tailscale_architecture" in
		amd64) tailscale_checksum=$TAILSCALE_SHA256_amd64 ;;
		arm64) tailscale_checksum=$TAILSCALE_SHA256_arm64 ;;
		*) echo "lib/tailscale.sh: no pinned Tailscale checksum for $tailscale_architecture; add one next to TAILSCALE_VERSION" >&2; return 1 ;;
	esac
	tailscale_archive="$tailscale_directory/tailscale_${TAILSCALE_VERSION}_$tailscale_architecture.tgz"
	curl --fail --silent --show-error --location --max-time "$DOWNLOAD_MAX_SECONDS" --output "$tailscale_archive" "$TAILSCALE_RELEASES/$(basename "$tailscale_archive")"
	echo "$tailscale_checksum  $tailscale_archive" | sha256sum --check --quiet -
	tar -xzf "$tailscale_archive" -C "$tailscale_directory" --strip-components 1
}
