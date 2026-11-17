# Inside the sandbox VM itself, as in the forced command of vm/session-keys, the VM's shell and Docker are reached directly.

sandbox_vm() {
	"$@"
}

sandbox_docker() {
	docker "$@"
}

vm_is_running() {
	true
}

refuse_inside_vm() {
	echo "$(basename "$0"): $1 runs on the operator's machine, not inside the sandbox VM" >&2
	exit 2
}

vm_start() {
	refuse_inside_vm vm-up
}

vm_forbidden_endpoints() {
	refuse_inside_vm probe-boundary
}
