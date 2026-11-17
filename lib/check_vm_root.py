#!/usr/bin/env python3
import os
import re
import shlex
import sys
from itertools import dropwhile
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY / "lib"))
from launch import LAUNCH

CLONE = LAUNCH["POTS_SESSION_REPOSITORY"]
UNIT_LAUNCHER = f"/usr/bin/python3 -I {LAUNCH['POTS_TRUSTED_SOURCE']}/lib/trusted_source.py"
UNIT_COMMAND = re.compile(rf"(?:{re.escape(UNIT_LAUNCHER)} (?:update|run [\w-]+(?:/[\w.-]+)*)|/usr/local/sbin/[\w-]+)(?: [\w=:,/.-]+)*")
UNIT_PREFIXES = "@-:+!"
UNIT_SUFFIXES = (".service", ".socket", ".timer", ".path", ".mount")
EXEC_KEY = re.compile(r"\s*(Exec\w*)\s*=\s*(.*?)\s*")
SHELL_SHEBANGS = (b"#!/bin/sh", b"#!/bin/bash", b"#!/usr/bin/env sh", b"#!/usr/bin/env bash")
SHEBANG_BYTES = 64
SKIPPED_DIRECTORIES = {"node_modules", "__pycache__"}
ENTRY = re.compile(r"(?<![\w/.-])sandbox_vm(?=\s|$)|(?<=/)vm-exec[\"']?(?=\s|$)")
TRANSPORT = re.compile(r"\b(?:colima ssh|limactl shell|qm guest exec)\b|\bssh\b.*\broot@")
TRANSPORT_HOMES = ("lib/providers/", "proxmox/")
LAUNCHER_ASSIGNMENT = re.compile(r"(?<![\w$])POTS_TRUSTED_(?:LAUNCHER|SOURCE)=")
LAUNCHER_HOME = "lib/sandbox.sh"
OPERATOR_LINES = {("bin/vm-exec", 'sandbox_vm "$@"')}
LAUNCHER_WORDS = ["python3", "-I", "$POTS_TRUSTED_LAUNCHER"]
LITERAL_COMMANDS = frozenset({"cat", "docker", "find", "id", "install", "ip6tables", "iptables", "sha256sum", "ss", "stat",
                              "systemctl", "tailscale", "test"})
INSTALLED_COPY = re.compile(r"/usr/local/sbin/[\w-]+")
ASSIGNMENT = re.compile(r"[A-Za-z_]\w*=")
SUDO_FLAGS = {"-n", "--non-interactive"}
SUDO_VALUE_OPTIONS = {"-u", "--user"}
SUDO_LISTING = {"-l", "--list"}
FIND_RUNNERS = {"-exec", "-execdir", "-ok", "-okdir"}
SHELL_OPERATORS = set("();<>|&")


def command_problem(words):
    words = list(dropwhile(ASSIGNMENT.match, words))
    if not words:
        return "names no command"
    head, rest = words[0], words[1:]
    if "$" in head or "`" in head:
        return f"runs the variable command {head}"
    if head == "sudo":
        return sudo_problem(rest)
    if head == "env":
        return f"passes env the option {rest[0]}" if rest and rest[0].startswith("-") else command_problem(rest)
    if words[:len(LAUNCHER_WORDS)] == LAUNCHER_WORDS or INSTALLED_COPY.fullmatch(head):
        return None
    if head not in LITERAL_COMMANDS:
        return f"runs {head}, which is neither the trusted launcher, an installed copy under /usr/local/sbin nor a VM management command"
    return find_problem(rest) if head == "find" else None


def sudo_problem(words):
    index = 0
    while index < len(words) and words[index].startswith("-"):
        option = words[index]
        if option in SUDO_LISTING:
            return None
        if option not in SUDO_FLAGS | SUDO_VALUE_OPTIONS:
            return f"passes sudo the option {option}"
        index += 2 if option in SUDO_VALUE_OPTIONS else 1
    return command_problem(words[index:])


def find_problem(words):
    problems = (command_problem(words[index + 1:]) for index, word in enumerate(words) if word in FIND_RUNNERS)
    return next((problem for problem in problems if problem), None)


# A call ends at its first shell operator; a quote left open before it makes the call unreadable, which is refused.
def call_words(rest):
    lexer = shlex.shlex(rest, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    words = []
    for token in lexer:
        if token and set(token) <= SHELL_OPERATORS:
            break
        words.append(token)
    return words


def call_problem(rest):
    try:
        return command_problem(call_words(rest))
    except ValueError as error:
        return f"cannot be read as one command ({error})"


def logical_lines(text):
    start, parts = None, []
    for number, line in enumerate(text.splitlines(), 1):
        start = start or number
        if line.endswith("\\"):
            parts.append(line[:-1])
            continue
        yield start, " ".join([*parts, line])
        start, parts = None, []


def shell_line_problems(relative, line):
    calls = (call_problem(line[entry.end():]) for entry in ENTRY.finditer(line))
    yield from (f"VM root {problem}" for problem in calls if problem)
    if TRANSPORT.search(line) and not relative.startswith(TRANSPORT_HOMES):
        yield "opens a VM shell outside the providers' sandbox_vm"
    if LAUNCHER_ASSIGNMENT.search(line) and relative != LAUNCHER_HOME:
        yield f"assigns the trusted launcher's path outside {LAUNCHER_HOME}"


def shell_problems(relative, text):
    for number, line in logical_lines(text):
        if line.lstrip().startswith("#") or (relative, line.strip()) in OPERATOR_LINES:
            continue
        yield from (f"{relative}:{number}: {problem}: {line.strip()}" for problem in shell_line_problems(relative, line))


def unit_line_problems(line):
    if CLONE in line:
        yield f"names the clone {CLONE}, whose files root runs only through the trusted launcher"
    key = EXEC_KEY.fullmatch(line)
    command = key.group(2).lstrip(UNIT_PREFIXES) if key else ""
    if key and (".." in command or not UNIT_COMMAND.fullmatch(command)):
        yield f"{key.group(1)} starts a program that is neither the trusted launcher nor an installed copy under /usr/local/sbin"


def unit_problems(relative, text):
    for number, line in logical_lines(text):
        yield from (f"{relative}:{number}: {problem}: {line.strip()}" for problem in unit_line_problems(line))


def checker_for(path):
    if path.suffix in UNIT_SUFFIXES:
        return unit_problems
    if path.suffix == ".sh":
        return shell_problems
    with path.open("rb") as handle:
        first_line = handle.readline(SHEBANG_BYTES).rstrip()
    return shell_problems if first_line in SHELL_SHEBANGS else None


def repository_files():
    for directory, names, files in os.walk(REPOSITORY):
        names[:] = sorted(name for name in names if not name.startswith(".") and name not in SKIPPED_DIRECTORIES)
        yield from (path for path in (Path(directory, name) for name in sorted(files)) if path.is_file())


def file_problems(path):
    checker = checker_for(path)
    if not checker:
        return []
    return list(checker(path.relative_to(REPOSITORY).as_posix(), path.read_text(errors="replace")))


def main():
    problems = [problem for path in repository_files() for problem in file_problems(path)]
    if not problems:
        return 0
    print("check: root in a VM runs the clone's code only through the trusted launcher, lib/trusted_source.py:",
          *problems, sep="\n  ", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
