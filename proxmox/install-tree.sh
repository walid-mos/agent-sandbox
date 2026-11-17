# Runs as root in a pot VM as `sh -c SCRIPT install-tree TARGET`, with a tar archive on stdin.
# TARGET ends up holding exactly the archive, readable by every user and writable by root only. A Git clone at TARGET updates itself, so it stays.
set -eu
[ $# -eq 1 ] || { echo 'usage: install-tree TARGET < archive.tar' >&2; exit 2; }
target=$1
if [ -e "$target/.git" ]; then
	echo "install-tree: $target is a Git clone, left as it is" >&2
	exit 0
fi
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
tar -x --no-same-owner -f - -C "$staging"
chmod -R u=rwX,go=rX "$staging"
mkdir -p "$target"
# Synced in place, never swapped: a running session binds TARGET and its directories, and a bind keeps a replaced directory's old copy.
rsync -a --delete "$staging/" "$target/"
