#!/usr/bin/env python3
import json
from pathlib import Path
import sys

from client_rules import REQUIRED, RULES_KEY, RUNTIME_OPTIONAL, SANDBOX_OPTIONAL, RulesRefused, approved_rules, read_json


def bundle(directory, runtime):
    configuration = {name: read_json(directory / name) for name in REQUIRED}
    configuration.update({name: read_json(directory / name) for name in SANDBOX_OPTIONAL if (directory / name).is_file()})
    configuration.update({name: read_json(runtime / name) for name in RUNTIME_OPTIONAL if (runtime / name).is_file()})
    rules = approved_rules(directory)
    if rules:
        configuration[RULES_KEY] = rules
    return configuration


def main():
    is_acknowledgement = len(sys.argv) > 1 and sys.argv[1] == "acknowledge"
    try:
        if is_acknowledgement:
            from client_rules_import import acknowledge_rules
            directory, expected = sys.argv[2:]
            acknowledge_rules(Path(directory), expected)
        else:
            directory, runtime = map(Path, sys.argv[1:])
            print(json.dumps(bundle(directory, runtime)))
    except (RulesRefused, OSError, ValueError, TypeError, KeyError):
        message = ("vm-config: VM transfer completed but its local receipt was not stored. Retry bin/vm-config."
                   if is_acknowledgement else
                   "vm-config: invalid configuration or unapproved client rules. Bundle text is withheld. Nothing was sent.")
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
