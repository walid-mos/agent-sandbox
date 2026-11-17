import json
import os
from pathlib import Path
import signal
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from launch import LAUNCH

SESSION = Path(__file__).resolve().parents[1]
ENVIRONMENT = {**{name: os.environ[name] for name in ("PATH", "HOME", "POTS_TOOLCHAIN")}, "POTS_ISOLATED_FACTORY": "1", "MAGPIE_API_KEY": "magpie", "LANG": "C.UTF-8"}
HOME = Path(ENVIRONMENT["HOME"])
FACTORY_UID = int(LAUNCH["POTS_FACTORY_UID"])
CHILDREN = []
BOOTSTRAP = Path(LAUNCH["POTS_FACTORY_BOOTSTRAP"])


def spawn(arguments, *, privilege, stdout=None):
    options = {"user": FACTORY_UID, "group": FACTORY_UID, "extra_groups": []} if privilege == "factory" else {}
    child = subprocess.Popen(arguments, env=ENVIRONMENT, start_new_session=True, stdout=stdout, **options)
    CHILDREN.append(child)
    return child


def command(arguments, *, input=None):
    result = subprocess.run(arguments, input=input, env=ENVIRONMENT, user=FACTORY_UID, group=FACTORY_UID, extra_groups=[], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError(f"factory: {Path(arguments[0]).name} failed. Check the isolated factory's bootstrap and credentials.")


def prepare_home():
    if HOME.is_symlink():
        raise RuntimeError("factory: the private home must not be a symlink.")
    os.chown(HOME, FACTORY_UID, FACTORY_UID)
    os.chmod(HOME, 0o700)


def seed_router():
    seed = BOOTSTRAP / "seed"
    passphrase = BOOTSTRAP / "passphrase"
    if not seed.is_file() or not passphrase.is_file():
        raise RuntimeError("factory: seed the isolated router from the Mac with bin/factory-bootstrap.")
    pending = HOME / ".factory-seed"
    with pending.open("wb") as output:
        output.write(seed.read_bytes())
    os.chown(pending, FACTORY_UID, FACTORY_UID)
    os.chmod(pending, 0o600)
    try:
        command(["magpie", "restore", "--no-agents", "--no-library", "--no-sign-ins", str(pending)], input=passphrase.read_bytes())
        command(["magpie", "update", "auto", "off"])
        command(["magpie", "group", "auto", "off"])
    finally:
        pending.unlink(missing_ok=True)


def wait_for_docker():
    result = subprocess.run(["/usr/bin/docker", "info"], env=ENVIRONMENT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError("factory: the isolated check engine did not start.")
    os.chown("/var/run/docker.sock", FACTORY_UID, FACTORY_UID)


def start_docker():
    daemon = spawn(["/usr/sbin/dockerd", "--data-root=/var/lib/docker"], privilege="root", stdout=subprocess.PIPE)
    for line in iter(daemon.stdout.readline, b""):
        if b"API listen on /var/run/docker.sock" in line:
            wait_for_docker()
            return
    raise RuntimeError("factory: the private check engine exited before readiness.")


def stop(*arguments):
    for child in reversed(CHILDREN):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    for child in reversed(CHILDREN):
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def main():
    signal.signal(signal.SIGTERM, lambda *arguments: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *arguments: sys.exit(0))
    try:
        prepare_home()
        start_docker()
        spawn([str(SESSION / "router")], privilege="factory")
        command([str(SESSION / "factory-runtime/wait-for-router")])
        seed_router()
        command([str(SESSION / "factory-runtime/initialize-bot")])
        gateway = spawn([str(SESSION / "with-vault"), "pots", "start"], privilege="factory")
        command(["node", str(SESSION / "factory-bot.mjs")])
        raise SystemExit(gateway.wait())
    finally:
        stop()


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
