import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from factory_socket import Refused
from launch import LAUNCH
from source_refresh import GIT_OPTIONS as SOURCE_GIT_OPTIONS

ENVIRONMENT = {"PATH": "/usr/bin:/bin", "LANG": "C", "HOME": "/nonexistent", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
GIT_OPTIONS = (*SOURCE_GIT_OPTIONS, "-c", "credential.helper=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never")

FACTORY_STATE = Path(LAUNCH["POTS_FACTORY_STATE"])
FACTORY_SEED = FACTORY_STATE / "bootstrap"


def execute(arguments, *, input=None, environment=ENVIRONMENT, timeout=120):
    result = subprocess.run(arguments, input=input, env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    if result.returncode:
        raise Refused(f"{Path(arguments[0]).name} refused the operation.")
    return result.stdout


def private_directory(path):
    if path.is_symlink():
        raise Refused(f"{path} must not be a symlink.")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    status = path.stat()
    if status.st_uid != os.geteuid() or status.st_mode & 0o077:
        raise Refused(f"{path} must be owned by this user and mode 0700.")


def gpg(home, *arguments):
    return execute(["/usr/bin/gpg", "--no-options", "--batch", "--homedir", str(home), *arguments])


def fingerprints(listing):
    return [line.split(":")[9] for line in listing.decode().splitlines() if line.startswith("fpr:")]
