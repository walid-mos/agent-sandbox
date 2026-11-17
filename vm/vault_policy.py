import json
import os
from pathlib import Path
import re
import stat

VAULT_PATH = re.compile(r"/([A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*)?")
SECRET_NAME = re.compile(r"[A-Z][A-Z0-9_]*")
GROUP = re.compile(r"[a-z][a-z0-9-]*")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
GITHUB_PATH = "/tools/github"
VAULT_ACCESS_PREFIX = "INFISICAL_"
WRITABLE_BY_OTHERS = stat.S_IWGRP | stat.S_IWOTH
ROOT = 0
REQUEST_FIELDS = {
    "sandbox": {"kind", "group"},
    "secret": {"kind", "path", "name"},
    "source": {"kind", "repository"},
}


class Refused(Exception):
    pass


def read_root_json(path):
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != ROOT or info.st_mode & WRITABLE_BY_OTHERS:
            raise Refused(f"{path} must be a regular file owned and written by root only. Run bin/vm-up for this pot.")
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        raise Refused(f"{path} is missing. Run bin/vm-up for this pot.") from None
    except ValueError:
        raise Refused(f"{path} is not JSON. Fix it on the Mac and run bin/vm-config.") from None


def listed_entry(path, name):
    if not isinstance(path, str) or not VAULT_PATH.fullmatch(path) or not isinstance(name, str) or not SECRET_NAME.fullmatch(name):
        raise Refused("sandbox.json names a vault folder or secret outside /folder and UPPER_CASE forms. Fix it and run bin/vm-config.")
    if name.startswith(VAULT_ACCESS_PREFIX):
        raise Refused(f"sandbox.json lists {name}, whose name carries vault access. Remove it and run bin/vm-config.")
    return path, name


def folder_entries(folders):
    if not isinstance(folders, dict) or not all(isinstance(names, list) for names in folders.values()):
        raise Refused("sandbox.json maps each vault folder to a list of names. Fix it and run bin/vm-config.")
    return [listed_entry(path, name) for path, names in folders.items() for name in names]


def default_entries(sandbox):
    owners = sandbox.get("owners") or {}
    if not isinstance(owners, dict):
        raise Refused("sandbox.json maps owners to token names. Fix it and run bin/vm-config.")
    return folder_entries({GITHUB_PATH: list(owners.values())}) + folder_entries(sandbox.get("secrets") or {})

def group_entries(sandbox, group):
    groups = sandbox.get("onRequest") or {}
    if not isinstance(group, str) or not GROUP.fullmatch(group):
        raise Refused("a group name holds lowercase letters, digits and dashes only.")
    if group not in groups:
        raise Refused(f"the sandbox names no secrets under onRequest.{group}. Add them to its sandbox.json.")
    return folder_entries(groups[group])


def every_entry(sandbox):
    groups = sandbox.get("onRequest") or {}
    return default_entries(sandbox) + [entry for group in groups for entry in group_entries(sandbox, group)]


def refused_jira(sandbox):
    group = sandbox.get("jira")
    if group is None:
        return
    if not isinstance(group, str) or not GROUP.fullmatch(group):
        raise Refused("sandbox.json jira must name one onRequest group. Fix it and run bin/vm-config.")
    names = {name for _, name in group_entries(sandbox, group)}
    groups = sandbox.get("onRequest") or {}
    duplicated = [entry for scope in [default_entries(sandbox)] + [group_entries(sandbox, other) for other in groups if other != group] for entry in scope if entry[1] in names]
    if duplicated:
        raise Refused(f"{duplicated[0][1]} is listed outside onRequest.{group}. Each Jira credential must stay in that one group. Fix it and run bin/vm-config.")


def sandbox_entries(request, sandbox, registry):
    group = request.get("group")
    return default_entries(sandbox) + ([] if group is None else group_entries(sandbox, group))


def secret_entries(request, sandbox, registry):
    path, name = request.get("path"), request.get("name")
    if not isinstance(path, str) or not VAULT_PATH.fullmatch(path) or not isinstance(name, str) or not SECRET_NAME.fullmatch(name):
        raise Refused("a secret request names one /folder and one UPPER_CASE name.")
    if (path, name) not in every_entry(sandbox):
        raise Refused(f"{name} in {path} is not listed in this pot's sandbox.json. Add it under secrets or onRequest.")
    return [(path, name)]


def selected_sources(sandbox):
    names = sandbox.get("sources", [])
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise Refused("sandbox.json selects its sources as a list of catalog names. Fix it and run bin/vm-config.")
    return names


# A source token reaches a pot only for a private source of the clone's catalog, one with a credential, that its sandbox.json selects.
def source_entries(request, sandbox, registry):
    repository = request.get("repository")
    if not isinstance(repository, str) or not REPOSITORY.fullmatch(repository):
        raise Refused("a source request names one OWNER/REPOSITORY.")
    matches = [name for name, source in registry.items() if isinstance(source, dict) and source.get("repository") == repository]
    if not matches:
        raise Refused(f"{repository} is outside the approved agent sources.")
    names = selected_sources(sandbox)
    selected = [name for name in matches if name in names]
    if not selected:
        raise Refused(f"sandbox.json selects none of {', '.join(matches)} under sources, so this pot does not fetch it.")
    credential = registry[selected[0]].get("credential")
    if credential is None:
        raise Refused(f"{repository} is public in the source catalog, so it is cloned with no token.")
    return [listed_entry(GITHUB_PATH, credential)]


REQUESTS = {"sandbox": sandbox_entries, "secret": secret_entries, "source": source_entries}


def entries_for(request, sandbox, registry):
    kind = request.get("kind") if isinstance(request, dict) else None
    if kind not in REQUESTS:
        raise Refused(f"expected a request of kind {', '.join(REQUESTS)} or ready.")
    if set(request) - REQUEST_FIELDS[kind]:
        raise Refused(f"a {kind} request holds only the fields {', '.join(sorted(REQUEST_FIELDS[kind]))}.")
    if not isinstance(sandbox, dict) or not isinstance(registry, dict):
        raise Refused("sandbox.json and the source catalog must each hold one JSON object.")
    refused_jira(sandbox)
    return list(dict.fromkeys(REQUESTS[kind](request, sandbox, registry)))
