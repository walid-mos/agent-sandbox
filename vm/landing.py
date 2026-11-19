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
LANDING_REF = "refs/heads/main"
REQUEST_FIELDS = {"repository", "number", "generation", "ref", "head", "base", "tree"}
MAX_SAFE_INTEGER = (1 << 53) - 1
PROVENANCE_HEADER = "Factory landing v1"
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
        self.operator_trust = Path(LAUNCH["POTS_TRUSTED_SIGNERS"])
        self.clone = Path(LAUNCH["POTS_SESSION_REPOSITORY"])
        private_directory(self.home)
        private_directory(self.state)
        self.key = fingerprint(self.home)
        if not self.store.exists():
            execute(["/usr/bin/git", *GIT_OPTIONS, "init", "--bare", str(self.store)])

    def git(self, *arguments, input=None, environment=ENVIRONMENT):
        return execute(["/usr/bin/git", "--no-replace-objects", *GIT_OPTIONS, "--git-dir", str(self.store), *arguments], input=input, environment=environment).decode().strip()

    def validate(self, request):
        if not isinstance(request, dict) or set(request) != REQUEST_FIELDS:
            raise Refused("landing: expected repository, number, generation, ref, head, base and tree only.")
        if request["repository"] != self.repository or request["ref"] != LANDING_REF:
            raise Refused("landing: wrong repository or target ref.")
        if not all(type(request[name]) is int and minimum <= request[name] <= MAX_SAFE_INTEGER
                   for name, minimum in (("number", 1), ("generation", 0))):
            raise Refused("landing: invalid pull request number or review generation.")
        if not all(isinstance(request[name], str) and OBJECT_ID.fullmatch(request[name]) for name in ("head", "base", "tree")):
            raise Refused("landing: expected full Git object IDs.")

    def fetch(self, request):
        self.git("fetch", "--no-tags", self.origin, f"+{LANDING_REF}:{LANDING_REF}", f"+refs/pull/{request['number']}/head:refs/heads/request")
        remote = self.git("rev-parse", LANDING_REF)
        if self.git("rev-parse", "refs/heads/request") != request["head"]:
            raise Refused("landing: the pull request head changed.")
        return remote

    def previous(self):
        return json.loads(self.receipt.read_text()) if self.receipt.exists() else {}

    def verify_release(self, request, previous):
        base, head, tree = (request[name] for name in ("base", "head", "tree"))
        anchor = execute(["/usr/bin/git", *GIT_OPTIONS, "-c", f"safe.directory={self.clone}", "-C", str(self.clone), "rev-parse", "HEAD"]).decode().strip()
        self.git("merge-base", "--is-ancestor", anchor, base)
        if previous:
            self.require_forward_base(previous, base)
        self.require_trusted_base(base, previous)
        self.git("merge-base", "--is-ancestor", base, head)
        if self.git("rev-parse", f"{head}^{{tree}}") != tree:
            raise Refused("landing: the proposed tree differs from the checked head.")

    def require_trusted_base(self, base, previous):
        if base == previous.get("commit") and self.key == previous.get("fingerprint"):
            return
        try:
            require_signed(self.store, base, self.operator_trust)
        except Untrusted as error:
            raise Refused("landing: the checked base is not a trusted signed tip.") from error

    def require_forward_base(self, previous, base):
        previous_base = previous["request"]["base"]
        if base == previous_base:
            raise Refused("landing: the saved candidate can still land on its checked base. Retry that exact release.")
        try:
            self.git("merge-base", "--is-ancestor", previous_base, base)
        except Refused as error:
            raise Refused("landing: the checked base does not advance the saved candidate's base.") from error

    def construct(self, request):
        message = f"{PROVENANCE_HEADER}\n\n{json.dumps(request, sort_keys=True, separators=(',', ':'))}\n"
        environment = {**ENVIRONMENT, "GNUPGHOME": str(self.home), "GIT_AUTHOR_NAME": IDENTITY_NAME, "GIT_AUTHOR_EMAIL": IDENTITY_EMAIL, "GIT_COMMITTER_NAME": IDENTITY_NAME, "GIT_COMMITTER_EMAIL": IDENTITY_EMAIL}
        commit = self.git("-c", "gpg.format=openpgp", "-c", "gpg.program=/usr/bin/gpg", "commit-tree", request["tree"], "-p", request["base"], f"-S{self.key}", input=message.encode(), environment=environment)
        encoded = base64.b64encode(execute(["/usr/bin/git", *GIT_OPTIONS, "--git-dir", str(self.store), "cat-file", "commit", commit])).decode()
        return {"commit": commit, "object": encoded, "fingerprint": self.key, "request": request}

    def save(self, release):
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

    def sign(self, request):
        self.validate(request)
        remote = self.fetch(request)
        previous = self.previous()
        if previous.get("fingerprint") == self.key and previous.get("request") == request and remote in (request["base"], previous["commit"]):
            return previous
        if remote != request["base"]:
            raise Refused("landing: the target moved from the checked base. Nothing was signed.")
        self.verify_release(request, previous)
        return self.save(self.construct(request))
