#!/usr/bin/env python3
import json
from pathlib import Path
import sys

from client_rules import RulesRefused, approved_rules, read_json

REQUIRED = ("sandbox.json", "vault.json")
OPTIONAL = ("git-identity.json",)


def bundle(directory, runtime):
    configuration = {name: read_json(directory / name) for name in REQUIRED}
    configuration.update({name: read_json(directory / name) for name in OPTIONAL if (directory / name).is_file()})
    if (runtime / "tailnet.json").is_file():
        configuration["tailnet.json"] = read_json(runtime / "tailnet.json")
    rules = approved_rules(directory)
    if rules:
        configuration["client-rules"] = rules
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
