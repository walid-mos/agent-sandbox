from pathlib import Path

from client_rules import digest, object_keys, refuse, regular_file, require_hash

BUNDLE_KEY = "client-rules"


def rules_replacement(bundle, directory):
    if BUNDLE_KEY not in bundle:
        return {}
    rules = bundle[BUNDLE_KEY]
    object_keys(rules, ("text", "sha256", "previousSha256"))
    text = rules["text"]
    if not isinstance(text, str) or not text:
        refuse("rules text must be nonempty UTF-8.")
    content = text.encode("utf-8")
    expected = require_hash(rules["sha256"])
    previous = require_hash(rules["previousSha256"])
    if digest(content) != expected:
        refuse("rules content differs from the approved hash.")
    target_name = bundle["sandbox.json"].get("rules")
    if not isinstance(target_name, str):
        refuse("sandbox.rules must name the installed rules file.")
    target = Path(target_name)
    if target.parent != directory or target.suffix != ".md" or target.name.startswith("."):
        refuse("rules target must be Markdown directly in the configuration directory.")
    if directory.resolve() != directory:
        refuse("configuration directory must not contain symlinks.")
    if target.exists() or target.is_symlink():
        current = regular_file(target).read_bytes()
        if digest(current) not in (previous, expected):
            refuse("installed rules differ from the expected previous or approved hash.")
    return {"target": target, "content": content}
