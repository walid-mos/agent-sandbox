import base64
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from factory_root import ENVIRONMENT, GIT_OPTIONS, execute, fingerprints, gpg, private_directory
from factory_socket import Refused
from launch import LAUNCH
from signed_commit import Untrusted, require_signed

OBJECT_ID = re.compile(r"[0-9a-f]{40}")
FINGERPRINT = re.compile(r"[0-9A-F]{40}")
REQUEST_FIELDS = {"repository", "number", "head", "merged", "base"}
IDENTITY_NAME = "PR factory"
IDENTITY_EMAIL = "factory@agent-sandbox.invalid"


def fingerprint(home):
    found = fingerprints(gpg(home, "--with-colons", "--list-secret-keys"))
    if len(found) != 1 or not FINGERPRINT.fullmatch(found[0]):
        raise Refused("landing: expected one factory signing key. Create it from the Mac with bin/landing-key create.")
    return found[0]


def created_key(home):
    try:
        return fingerprint(home) if home.is_dir() else None
    except Refused:
        return None


class Signer:
    def __init__(self):
        self.home = Path(LAUNCH["POTS_LANDING_KEY_HOME"])
        self.state = Path(LAUNCH["POTS_LANDING_STATE"])
        self.store = self.state / "objects.git"
        self.receipt = self.state / "release.json"
        self.origin = LAUNCH["POTS_SOURCE_URL"]
        self.repository = LAUNCH["POTS_LANDING_REPOSITORY"]
        self.trust = Path(LAUNCH["POTS_TRUSTED_SIGNERS"])
        self.clone = Path(LAUNCH["POTS_SESSION_REPOSITORY"])
        private_directory(self.home)
        private_directory(self.state)
        self.key = fingerprint(self.home)
        if not self.store.exists():
            execute(["/usr/bin/git", *GIT_OPTIONS, "init", "--bare", str(self.store)])

    def git(self, *arguments, input=None, environment=ENVIRONMENT):
        return execute(["/usr/bin/git", *GIT_OPTIONS, "--git-dir", str(self.store), *arguments], input=input, environment=environment).decode().strip()

    def validate(self, request):
        if not isinstance(request, dict) or set(request) != REQUEST_FIELDS:
            raise Refused("landing: expected repository, number, head, merged and base only.")
        if request["repository"] != self.repository or type(request["number"]) is not int or request["number"] <= 0:
            raise Refused("landing: wrong repository or pull request number.")
        if not all(isinstance(request[name], str) and OBJECT_ID.fullmatch(request[name]) for name in ("head", "merged", "base")):
            raise Refused("landing: expected full commit IDs.")

    def fetch(self, request):
        self.git("fetch", "--no-tags", self.origin, "+refs/heads/main:refs/heads/main", f"+refs/pull/{request['number']}/head:refs/heads/request")
        remote = self.git("rev-parse", "refs/heads/main")
        if self.git("rev-parse", "refs/heads/request") != request["head"]:
            raise Refused("landing: the pull request head changed.")
        return remote

    def previous(self):
        return json.loads(self.receipt.read_text()) if self.receipt.exists() else {}

    def verify_release(self, request, previous):
        merged, base, head = (request[name] for name in ("merged", "base", "head"))
        if self.git("show", "--no-patch", "--format=%P", merged).split() != [base]:
            raise Refused("landing: the squash must have exactly the last trusted tip as its parent.")
        anchor = previous.get("commit")
        if not anchor:
            anchor = execute(["/usr/bin/git", *GIT_OPTIONS, "-c", f"safe.directory={self.clone}", "-C", str(self.clone), "rev-parse", "HEAD"]).decode().strip()
        self.git("merge-base", "--is-ancestor", anchor, base)
        try:
            require_signed(self.store, base, self.trust)
        except Untrusted as error:
            raise Refused("landing: the squash parent is not a trusted signed tip.") from error
        self.git("merge-base", "--is-ancestor", base, head)
        if self.git("rev-parse", f"{merged}^{{tree}}") != self.git("rev-parse", f"{head}^{{tree}}"):
            raise Refused("landing: the squash tree differs from the checked head.")

    def construct(self, request):
        merged = request["merged"]
        tree = self.git("rev-parse", f"{merged}^{{tree}}")
        message = f"Factory landing for {self.repository}#{request['number']}\n\nHead: {request['head']}\nBase: {request['base']}\nSquash: {merged}\n"
        environment = {**ENVIRONMENT, "GNUPGHOME": str(self.home), "GIT_AUTHOR_NAME": IDENTITY_NAME, "GIT_AUTHOR_EMAIL": IDENTITY_EMAIL, "GIT_COMMITTER_NAME": IDENTITY_NAME, "GIT_COMMITTER_EMAIL": IDENTITY_EMAIL}
        commit = self.git("-c", "gpg.format=openpgp", "-c", "gpg.program=/usr/bin/gpg", "commit-tree", tree, "-p", merged, f"-S{self.key}", input=message.encode(), environment=environment)
        encoded = base64.b64encode(execute(["/usr/bin/git", *GIT_OPTIONS, "--git-dir", str(self.store), "cat-file", "commit", commit])).decode()
        return {"commit": commit, "object": encoded, "fingerprint": self.key, "request": request}

    def sign(self, request):
        self.validate(request)
        remote = self.fetch(request)
        previous = self.previous()
        if previous.get("request") == request and remote in (request["merged"], previous["commit"]):
            return previous
        if remote != request["merged"]:
            raise Refused("landing: main moved. Nothing was signed.")
        self.verify_release(request, previous)
        release = self.construct(request)
        pending = self.receipt.with_suffix(".next")
        with open(pending, "w", opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW, 0o600)) as output:
            json.dump(release, output)
            output.flush()
            os.fsync(output.fileno())
        pending.replace(self.receipt)
        directory = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return release
