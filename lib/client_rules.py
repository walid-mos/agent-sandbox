import hashlib
import json
from pathlib import Path
import re
import stat
import tempfile
import os

STATE_FILE = "client-rules.json"
SNAPSHOT_FILE = "client-rules.md"
HASH = re.compile(r"[a-f0-9]{64}")
PRIVATE_FILE = 0o600
SNAPSHOT_MODE = 0o444


class RulesRefused(RuntimeError):
    pass


def refuse(reason):
    raise RulesRefused(f"client-rules: {reason}")


def digest(content):
    return hashlib.sha256(content).hexdigest()


def require_hash(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        refuse("expected a lowercase SHA-256 digest.")
    return value


def object_keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        refuse("unexpected object fields. Check the documented schema.")


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refuse("duplicate JSON fields are ambiguous.")
        result[key] = value
    return result


def read_json(path):
    return parse_json(Path(path).read_bytes())


def parse_json(content):
    try:
        return json.loads(content, object_pairs_hook=unique_keys)
    except (ValueError, UnicodeError):
        refuse("expected UTF-8 JSON. Input text is withheld.")


def regular_file(path):
    path = Path(path).absolute()
    if path.resolve() != path or not stat.S_ISREG(path.lstat().st_mode):
        refuse("expected a regular file without symlinks.")
    return path


def source_file(directory, relative):
    if not isinstance(relative, str):
        refuse("source file must be a relative path.")
    parts = relative.split("/")
    if any(part in ("", ".", "..", ".git") for part in parts) or "\\" in relative:
        refuse("source file must stay inside its checkout.")
    path = Path(directory).absolute().joinpath(*parts)
    if path.resolve() != path:
        refuse("source path contains a symlink.")
    return path


def replacement_span(original, replacement):
    object_keys(replacement, ("before", "after"))
    before, after = replacement["before"], replacement["after"]
    if not all(isinstance(value, str) and value.endswith("\n") for value in (before, after)) or before == after:
        refuse("each replacement must change complete nonempty lines.")
    before, after = before.encode("utf-8"), after.encode("utf-8")
    position = original.find(before)
    if original.count(before) != 1 or (position and original[position - 1:position] != b"\n"):
        refuse("an anchor is missing, repeated or not at a line boundary.")
    return {"start": position, "end": position + len(before), "after": after}


def apply_recipe(original, recipe):
    object_keys(recipe, ("inputSha256", "replacements"))
    if digest(original) != require_hash(recipe["inputSha256"]):
        refuse("original hash differs from the reviewed recipe. Nothing was changed.")
    replacements = recipe["replacements"]
    if not isinstance(replacements, list) or not replacements:
        refuse("expected a nonempty replacements array.")
    spans = sorted((replacement_span(original, item) for item in replacements), key=lambda span: span["start"])
    position, pieces = 0, []
    for span in spans:
        if span["start"] < position:
            refuse("replacement anchors overlap. Nothing was changed.")
        pieces.extend((original[position:span["start"]], span["after"]))
        position = span["end"]
    return b"".join([*pieces, original[position:]])


def replace_file(path, content, mode=PRIVATE_FILE):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".client-rules-", delete=False) as pending:
        pending_path = Path(pending.name)
        try:
            os.fchmod(pending.fileno(), mode)
            pending.write(content)
            pending.flush()
            os.fsync(pending.fileno())
            pending_path.replace(path)
        finally:
            pending_path.unlink(missing_ok=True)


def state_bytes(state):
    return (json.dumps(state, indent=2) + "\n").encode()


def rules_text(content):
    try:
        text = content.decode("utf-8")
    except UnicodeError:
        text = ""
    if not text:
        refuse("rules must be nonempty UTF-8. Input text is withheld.")
    return text


def approved_state(directory):
    directory = Path(directory).absolute()
    state_path = directory / STATE_FILE
    if not state_path.exists() and not state_path.is_symlink():
        return None
    state = read_json(regular_file(state_path))
    object_keys(state, ("source", "file", "sha256", "previousSha256", "original"))
    snapshot = regular_file(directory / SNAPSHOT_FILE).read_bytes()
    if digest(snapshot) != require_hash(state["sha256"]):
        refuse("approved snapshot hash differs. Run client-rules approve after review.")
    original = Path(state["original"])
    if not original.is_symlink() or original.readlink() != directory / SNAPSHOT_FILE:
        refuse("original path no longer links to the approved snapshot.")
    require_hash(state["previousSha256"])
    return state, rules_text(snapshot)


def approved_rules(directory):
    approved = approved_state(directory)
    if approved is None:
        return {}
    state, text = approved
    return {"text": text, "sha256": state["sha256"], "previousSha256": state["previousSha256"]}


def rules_target(name, directory):
    if not isinstance(name, str):
        refuse("sandbox.rules must name the installed rules file.")
    target = Path(name)
    if target.parent != directory or target.suffix != ".md" or target.name.startswith("."):
        refuse("rules target must be Markdown directly in the configuration directory.")
    return target


def verified_rules(payload, target_name, directory):
    object_keys(payload, ("text", "sha256", "previousSha256"))
    if not isinstance(payload["text"], str):
        refuse("rules text must be a string.")
    content = payload["text"].encode("utf-8")
    rules_text(content)
    expected = require_hash(payload["sha256"])
    previous = require_hash(payload["previousSha256"])
    if digest(content) != expected:
        refuse("rules content differs from the approved hash.")
    target = rules_target(target_name, directory)
    if directory.resolve() != directory:
        refuse("configuration directory must not contain symlinks.")
    if target.exists() or target.is_symlink():
        current = regular_file(target).read_bytes()
        if digest(current) not in (previous, expected):
            refuse("installed rules differ from the expected previous or approved hash.")
    return {"target": target, "content": content}
