from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import subprocess
import tempfile

from agent_sources import source_catalog
from source_refresh import SAFE_CONFIG, git
from client_rules import (PRIVATE_FILE, SNAPSHOT_FILE, SNAPSHOT_MODE, STATE_FILE, apply_recipe,
                          approved_state, digest, parse_json, read_json, refuse, regular_file,
                          replace_file, require_hash, rules_target, rules_text, source_file, state_bytes)

LAUNCH_ENV = Path(__file__).resolve().parents[1] / "session/launch.env"
SESSION_CONFIGURATION = Path(re.search(r"^POTS_SESSION_CONFIGURATION=(.+)$", LAUNCH_ENV.read_text(), re.MULTILINE).group(1))


@contextmanager
def locked(directory):
    if directory.resolve() != directory:
        refuse("sandbox directory must not contain symlinks.")
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def private_checkout(name):
    source = source_catalog().get(name)
    if not source:
        refuse("select a source from session/agent-sources.json.")
    result = subprocess.run(["gh", "api", f"repos/{source['repository']}", "--jq", ".private"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
    if result.returncode or result.stdout.strip() != "true":
        refuse("source privacy could not be confirmed. No client text was written.")
    checkout = Path.home() / source["directory"]
    if checkout.resolve() != checkout or not (checkout / ".git").is_dir() or (checkout / ".git").is_symlink():
        refuse("selected private source clone is missing or symlinked. Provision it first.")
    require_origin(checkout, source["repository"])
    return checkout


def require_origin(checkout, repository):
    try:
        keys = git(checkout, "config", "--local", "--name-only", "--list").splitlines()
        origin = git(checkout, "config", "--local", "--get", "remote.origin.url")
    except RuntimeError:
        refuse("source origin could not be verified. No client text was written.")
    if any(not SAFE_CONFIG.fullmatch(key) for key in keys):
        refuse("source clone has unsupported Git configuration.")
    if origin.removesuffix(".git") != f"https://github.com/{repository}":
        refuse("checkout origin differs from the catalog's private repository.")


def require_selected(directory, source):
    configuration = read_json(regular_file(directory / "sandbox.json"))
    if not isinstance(configuration, dict):
        refuse("sandbox.json must be an object.")
    sources = configuration.get("sources", [])
    if not isinstance(sources, list) or source not in sources:
        refuse("source is not selected in this sandbox's sources.")
    rules_target(configuration.get("rules"), SESSION_CONFIGURATION)


def import_rules(directory, checkout_for, source, original, relative, recipe, recipe_hash):
    with locked(directory):
        require_selected(directory, source)
        checkout = checkout_for(source)
        original = regular_file(original)
        before = original.read_bytes()
        plan = regular_file(source_file(checkout, recipe)).read_bytes()
        if digest(plan) != require_hash(recipe_hash):
            refuse("recipe differs from the explicitly reviewed hash.")
        after = apply_recipe(before, parse_json(plan))
        rules_text(after)
        target = source_file(checkout, relative)
        if target.suffix != ".md" or not target.parent.is_dir():
            refuse("canonical target must be Markdown inside an existing source directory.")
        state = {"source": source, "file": relative, "sha256": digest(after),
                 "previousSha256": digest(before), "original": str(original)}
        install_import(directory, original, target, before, after, state)
        return state


def install_import(directory, original, target, before, after, state):
    original_mode = original.stat().st_mode & 0o777
    created = []
    contents = [(target, after, PRIVATE_FILE), (directory / SNAPSHOT_FILE, after, SNAPSHOT_MODE),
                (directory / STATE_FILE, state_bytes(state), PRIVATE_FILE)]
    if any(path.exists() or path.is_symlink() for path, _, _ in contents):
        refuse("import destination already exists. Existing files were preserved.")
    try:
        for path, content, mode in contents:
            with path.open("xb") as output:
                created.append(path)
                os.fchmod(output.fileno(), mode)
                output.write(content)
        replace_original(original, before, directory / SNAPSHOT_FILE)
    except BaseException:
        if original.is_symlink() and original.readlink() == directory / SNAPSHOT_FILE:
            replace_file(original, before, original_mode)
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise


def replace_original(original, before, snapshot):
    with tempfile.TemporaryDirectory(dir=original.parent, prefix=".client-rules-") as staging:
        link = Path(staging) / original.name
        link.symlink_to(snapshot)
        if regular_file(original).read_bytes() != before:
            refuse("original changed during import. Existing content was preserved.")
        link.replace(original)


def approve_rules(directory, checkout_for, expected):
    with locked(directory):
        approved = approved_state(directory)
        if approved is None:
            refuse("no imported rules in this sandbox. Run client-rules import first.")
        state, text = approved
        require_selected(directory, state["source"])
        checkout = checkout_for(state["source"])
        candidate = regular_file(source_file(checkout, state["file"])).read_bytes()
        rules_text(candidate)
        if digest(candidate) != require_hash(expected):
            refuse("source hash differs from the explicitly approved hash.")
        if expected == state["sha256"]:
            return state
        updated = {**state, "previousSha256": state["sha256"], "sha256": expected}
        snapshot = directory / SNAPSHOT_FILE
        replace_file(snapshot, candidate, SNAPSHOT_MODE)
        try:
            replace_file(directory / STATE_FILE, state_bytes(updated))
        except BaseException:
            replace_file(snapshot, text.encode("utf-8"), SNAPSHOT_MODE)
            raise
        return updated
