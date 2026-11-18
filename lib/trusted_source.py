#!/usr/bin/env python3
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True

BUNDLE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BUNDLE / "lib"))
from signed_commit import Untrusted, read_signers, require_signed
from source_refresh import GIT_OPTIONS, SAFE_CONFIG, git_environment, refresh

LAUNCH = dict(line.split("=", 1) for line in (BUNDLE / "session/launch.env").read_text().splitlines() if line)
CLONE = Path(LAUNCH["POTS_SESSION_REPOSITORY"])
SIGNERS = LAUNCH["POTS_TRUSTED_SIGNERS"]
SOURCE_URL = LAUNCH["POTS_SOURCE_URL"]
RECEIVER = Path(LAUNCH['POTS_RECEIVER'])
TRUSTED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
WRITABLE_BY_OTHERS = stat.S_IWGRP | stat.S_IWOTH
ROOT = 0
# Git refuses a clone another user owns; the ownership walk has already proven this one root-owned.
CLONE_GIT_OPTIONS = ("-c", f"safe.directory={CLONE}")
USAGE = 'usage: trusted_source.py scheduled|keep|initialize-receiver|status-receiver|update [--branch BRANCH]|run SCRIPT [ARGUMENT...]|verify'


def clone_git(*arguments):
    result = subprocess.run(["git", *GIT_OPTIONS, *CLONE_GIT_OPTIONS, "--no-optional-locks", "-C", str(CLONE), *arguments],
                            env=git_environment(), text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise Untrusted(f"trusted-source: git {arguments[0]} failed in {CLONE}. Run bin/vm-up from the operator's checkout.")
    return result.stdout.strip()


def stop_walk(error):
    raise error


def clone_entries(root):
    yield str(root)
    for directory, names, files in os.walk(root, onerror=stop_walk):
        yield from (os.path.join(directory, name) for name in names + files)


def is_untrusted(path):
    info = os.lstat(path)
    return info.st_uid != ROOT or (not stat.S_ISLNK(info.st_mode) and bool(info.st_mode & WRITABLE_BY_OTHERS))


def require_root_owned():
    if CLONE.is_symlink() or CLONE.resolve() != CLONE:
        raise Untrusted(f"trusted-source: {CLONE} holds a symlink. Only a root-owned clone runs.")
    untrusted = [path for path in [*map(str, CLONE.parents), *clone_entries(CLONE)] if is_untrusted(path)]
    if untrusted:
        raise Untrusted(f"trusted-source: {untrusted[0]} and {len(untrusted) - 1} more paths are not root-owned or are writable by others. Nothing ran.")


def require_trusted_clone():
    require_root_owned()
    forbidden = [key for key in clone_git("config", "--local", "--name-only", "--list").splitlines() if not SAFE_CONFIG.fullmatch(key)]
    if forbidden:
        raise Untrusted(f"trusted-source: {CLONE} has unsupported Git configuration: {', '.join(forbidden)}. Nothing ran.")
    if clone_git("status", "--porcelain", "--untracked-files=all"):
        raise Untrusted(f"trusted-source: {CLONE} holds edited or untracked files. Nothing ran.")
    return require_signed(CLONE, "HEAD", SIGNERS, CLONE_GIT_OPTIONS)


def tracked_script(script):
    relative = Path(script)
    if relative.is_absolute() or ".." in relative.parts or clone_git("ls-files", "--full-name", "--", script) != relative.as_posix():
        raise Untrusted(f"trusted-source: {script} is not a file the clone tracks. Name it relative to {CLONE}.")
    target = (CLONE / relative).resolve()
    if not target.is_relative_to(CLONE):
        raise Untrusted(f"trusted-source: {script} leads outside {CLONE}.")
    return target


def run_environment():
    inherited = {key: value for key, value in git_environment().items() if not key.startswith("GIT_")}
    return {**inherited, "PATH": TRUSTED_PATH, "PYTHONDONTWRITEBYTECODE": "1"}


def run(script, *arguments):
    if os.path.lexists(RECEIVER) and script in ('vm/keeper', 'bin/pots-session', 'bin/sealskin-apply'):
        if script == 'bin/pots-session' and arguments == ('ensure',):
            return keep()
        raise Untrusted('trusted-source: the managed receiver owns session starts and restarts. Use keep for the known-good release.')
    require_trusted_clone()
    target = tracked_script(script)
    os.chdir("/")
    os.execve(target, [str(target), *arguments], run_environment())


def verify():
    print(require_trusted_clone())


def require_signed_candidate(directory, revision):
    require_signed(directory, revision, SIGNERS)


# The clone keeps the branch it follows; only a first clone takes one.
def update(*arguments):
    if os.geteuid() != ROOT:
        raise Untrusted("trusted-source: update runs as root.")
    if os.path.lexists(RECEIVER):
        raise Untrusted('trusted-source: the managed receiver owns scheduled updates for this VM.')
    if arguments and arguments[0] != "--branch":
        raise Untrusted(USAGE)
    read_signers(SIGNERS)
    if CLONE.exists():
        require_root_owned()
    branch = arguments[1] if arguments else clone_git("symbolic-ref", "--quiet", "--short", "HEAD")
    print(json.dumps(refresh(SOURCE_URL, CLONE, branch=branch, verify=require_signed_candidate)))


def vm_receiver(root):
    from receiver_vm import VmReceiver
    return VmReceiver(root, LAUNCH, BUNDLE, run_environment())


def receiver_operation(operation):
    from managed_receiver import run as run_receiver
    result = run_receiver(SimpleNamespace(root=RECEIVER, operation=operation), vm_receiver)
    print(json.dumps(result))
    return int(result['blocked'] is not None)


def scheduled():
    if not os.path.lexists(RECEIVER):
        return update()
    return receiver_operation('poll')


def keep():
    if not os.path.lexists(RECEIVER):
        return run('vm/keeper')
    print(vm_receiver(RECEIVER).keep())


def initialize_receiver():
    return receiver_operation('initialize')


def status_receiver():
    return receiver_operation('status')


COMMANDS = {
    'scheduled': (scheduled, lambda count: count == 0),
    'keep': (keep, lambda count: count == 0),
    'initialize-receiver': (initialize_receiver, lambda count: count == 0),
    'status-receiver': (status_receiver, lambda count: count == 0),
    "update": (update, lambda count: count in (0, 2)),
    "run": (run, lambda count: count >= 1),
    "verify": (verify, lambda count: count == 0),
}


def main(arguments):
    command, accepts = COMMANDS.get(arguments[0] if arguments else "", (None, None))
    if not command or not accepts(len(arguments) - 1):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        return command(*arguments[1:]) or 0
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
