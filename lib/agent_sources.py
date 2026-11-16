from contextlib import nullcontext
import json
import os
from pathlib import Path
import subprocess

from source_refresh import refresh

HOME = Path.home()
STATE = HOME / ".config/agent-sandbox"
HERDR_APP_HOME = HOME / ".config/herdr-app"
HERDR_KEYS = HERDR_APP_HOME / "keys.json"
HERDR_RUNTIME = STATE / "herdr-runtime.json"
PROVISIONING_FILE = STATE / "provisioning.json"
INSTALL_ENV = {key: value for key, value in os.environ.items()
               if key in ("HOME", "PATH", "TMPDIR", "DISPLAY", "LANG", "SYSTEMROOT")}


def source_catalog():
    return json.loads((Path(__file__).resolve().parents[1] / "session/agent-sources.json").read_text())


def refresh_source(source, configuration, fetch_with=(), installer_edits=nullcontext):
    url = source.get("url") or f'https://github.com/{source["repository"]}.git'
    return refresh(url, HOME / source["directory"], fetch_with=fetch_with,
                   allow_cutover=configuration.get("allowCutover", False), installer_edits=installer_edits)


# Herdr writes its key bindings on its first start, and its installer only adds shortcuts to that file.
def is_herdr_initialized():
    return HERDR_KEYS.is_file()


def require_herdr_initialized():
    if not is_herdr_initialized():
        raise RuntimeError(f"Herdr has not created {HERDR_KEYS}. Start Herdr once, then run this again. Nothing was changed.")


def install_herdr(checkout, profile, runtime):
    STATE.mkdir(parents=True, exist_ok=True)
    HERDR_RUNTIME.write_text(json.dumps(runtime) + "\n")
    subprocess.run([str(checkout / "bin/update"), "--home", str(HERDR_APP_HOME), "--profile", profile, "--runtime", str(HERDR_RUNTIME)], check=True, env=INSTALL_ENV)
