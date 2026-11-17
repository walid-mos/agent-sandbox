#!/usr/bin/env python3
import json
from pathlib import Path
import sys

from client_rules import RulesRefused, approved_rules, read_json

REQUIRED = ("sandbox.json", "vault.json")
SANDBOX_OPTIONAL = ("git-identity.json",)
RUNTIME_OPTIONAL = ("tailnet.json",)
OPTIONAL = SANDBOX_OPTIONAL + RUNTIME_OPTIONAL
RULES_KEY = "client-rules"


def bundle(directory, runtime):
    configuration = {name: read_json(directory / name) for name in REQUIRED}
    configuration.update({name: read_json(directory / name) for name in SANDBOX_OPTIONAL if (directory / name).is_file()})
    configuration.update({name: read_json(runtime / name) for name in RUNTIME_OPTIONAL if (runtime / name).is_file()})
    rules = approved_rules(directory)
    if rules:
        configuration[RULES_KEY] = rules
    return configuration


def main():
    try:
        directory, runtime = map(Path, sys.argv[1:])
        print(json.dumps(bundle(directory, runtime)))
    except (RulesRefused, OSError, ValueError, TypeError, KeyError):
        print("vm-config: invalid configuration or unapproved client rules. Bundle text is withheld. Nothing was sent.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
