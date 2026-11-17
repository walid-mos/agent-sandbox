#!/usr/bin/env python3
import argparse
from contextlib import nullcontext
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SAFE_CONFIG = re.compile(r"^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\.[^.]+\.(remote|merge)|user\.(name|email))$", re.I)
BRANCH = "main"
PREVIOUS_HEAD_REF = "refs/agent-sandbox/before-origin-switch"
GIT_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"]


def git_environment():
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("GIT_", "LD_", "DYLD_", "NODE_", "PYTHON")) and key not in ("BASH_ENV", "ENV")}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0")
    return environment


def git(directory, *arguments, prefix=()):
    result = subprocess.run([*prefix, "git", *GIT_OPTIONS, "-C", str(directory), *arguments],
                            env=git_environment(), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f"source-refresh: git {arguments[0]} failed for {directory}. Check repository access and source state.")
    return result.stdout.strip()


def require_safe_checkout(directory, branch):
    configuration = git(directory, "config", "--local", "--name-only", "--list").splitlines()
    forbidden = [key for key in configuration if not SAFE_CONFIG.fullmatch(key)]
    if forbidden:
        raise RuntimeError(f"source-refresh: {directory} has unsupported Git configuration: {', '.join(forbidden)}. Review it before updating.")
    current = git(directory, "branch", "--show-current")
    if current != branch:
        raise RuntimeError(f"source-refresh: left {directory} on {current or 'detached HEAD'}. Updates require {branch}.")


def require_clean(directory):
    if git(directory, "status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError(f"source-refresh: left edited files in {directory} untouched. Commit or move them before updating.")


# installer_edits(directory) sets aside the edits the source's installer makes to tracked files and puts them back on exit.
# It runs after the configuration check, because restoring a tracked file can run a configured filter.
def refresh(url, directory, fetch_with=(), allow_cutover=False, installer_edits=nullcontext, branch=BRANCH):
    directory = Path(directory).absolute()
    if directory.resolve() != directory:
        raise RuntimeError(f"source-refresh: {directory} contains a symlink. Use an owned source directory.")
    if not directory.exists():
        directory.mkdir(parents=True)
        git(directory, "init", "--quiet", "--initial-branch", branch)
        git(directory, "remote", "add", "origin", url)
    if (directory / ".git").is_symlink() or not (directory / ".git").is_dir():
        raise RuntimeError(f"source-refresh: {directory} is not a source clone. Existing files were left untouched.")
    require_safe_checkout(directory, branch)
    with installer_edits(directory):
        require_clean(directory)
        return advance(url, directory, fetch_with, allow_cutover, branch)


def advance(url, directory, fetch_with, allow_cutover, branch):
    origin = git(directory, "remote", "get-url", "origin")
    switching = origin.removesuffix(".git") != url.removesuffix(".git")
    if switching and not allow_cutover:
        raise RuntimeError(f"source-refresh: {directory} has another origin. After reviewing its state, enable allowCutover in private provisioning.json, or pass --allow-cutover to this script.")
    git(directory, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", url, f"refs/heads/{branch}", prefix=fetch_with)
    revision = git(directory, "rev-parse", "FETCH_HEAD^{commit}")
    result = {"directory": str(directory), "revision": revision}
    if switching:
        result["previous"] = cutover(url, directory, revision)
    else:
        git(directory, "merge", "--quiet", "--ff-only", "--no-edit", revision)
    git(directory, "update-ref", f"refs/remotes/origin/{branch}", revision)
    return result


def cutover(url, directory, revision):
    previous = git(directory, "rev-parse", "HEAD")
    if previous != revision:
        git(directory, "update-ref", PREVIOUS_HEAD_REF, previous)
        git(directory, "reset", "--quiet", "--keep", revision)
    git(directory, "remote", "set-url", "origin", url)
    return previous


def main():
    parser = argparse.ArgumentParser(description="Fast-forward a clean source clone without switching branches or discarding files.")
    parser.add_argument("url")
    parser.add_argument("directory")
    parser.add_argument("--allow-cutover", action="store_true")
    parser.add_argument("--branch", default=BRANCH)
    arguments = parser.parse_args()
    try:
        print(json.dumps(refresh(arguments.url, arguments.directory, allow_cutover=arguments.allow_cutover, branch=arguments.branch)))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
