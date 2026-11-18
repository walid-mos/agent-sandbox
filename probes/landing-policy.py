#!/usr/bin/env python3
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

REPOSITORY = Path(__file__).resolve().parents[1]
FIXED_ENVIRONMENT = {"PATH": "/usr/bin:/bin", "LANG": "C", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_AUTHOR_NAME": "probe", "GIT_AUTHOR_EMAIL": "probe@invalid", "GIT_COMMITTER_NAME": "probe", "GIT_COMMITTER_EMAIL": "probe@invalid"}


def run(*arguments, input=None, environment=FIXED_ENVIRONMENT, stderr=subprocess.DEVNULL):
    return subprocess.check_output(arguments, input=input, env=environment, stderr=stderr).decode().strip()


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *arguments):
        pass


class LandingPolicy(unittest.TestCase):
    def setUp(self):
        self.addCleanup(self.cleanup)
        self.temporary = tempfile.TemporaryDirectory(prefix="factory-landing-probe-")
        self.root = Path(self.temporary.name)
        self.homes = []
        self.server = None
        self.thread = None
        self.operator, self.operator_key = self.key("operator")
        self.factory, self.factory_key = self.key("factory")
        self.clone = self.root / "clone"
        served = self.root / "served"
        served.mkdir()
        self.remote = served / "remote.git"
        run("git", "init", "--quiet", "--initial-branch=main", str(self.clone))
        self.git("commit", "--quiet", "--allow-empty", f"-S{self.operator_key}", "-m", "operator anchor", environment={**FIXED_ENVIRONMENT, "GNUPGHOME": str(self.operator)})
        self.base = self.git("rev-parse", "HEAD")
        (self.clone / "change").write_text("checked content\n")
        self.git("add", "change")
        self.git("commit", "--quiet", "-m", "checked head")
        self.head = self.git("rev-parse", "HEAD")
        self.tree = self.git("rev-parse", f"{self.head}^{{tree}}")
        run("git", "clone", "--quiet", "--bare", str(self.clone), str(self.remote))
        self.publish(self.base, self.head)
        self.git("reset", "--quiet", "--hard", self.base)
        handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(served), **kwargs)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.prepare_source()
        self.signer = self.module.Signer()
        self.request = {"repository": self.signer.repository, "number": 30, "generation": 1, "ref": self.module.LANDING_REF, "head": self.head, "base": self.base, "tree": self.tree}

    def cleanup(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()
        for home in self.homes:
            subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "all"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if hasattr(self, "temporary"):
            self.temporary.cleanup()

    def key(self, name):
        home = self.root / name
        home.mkdir(mode=0o700)
        self.homes.append(home)
        run("gpg", "--no-options", "--batch", "--homedir", str(home), "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", f"{name} <{name}@invalid>", "ed25519", "sign", "0")
        listing = run("gpg", "--no-options", "--batch", "--homedir", str(home), "--with-colons", "--list-keys")
        return home, next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))

    def git(self, *arguments, input=None, environment=FIXED_ENVIRONMENT):
        return run("git", "-C", str(self.clone), *arguments, input=input, environment=environment)

    def publish(self, tip, head):
        self.git("push", "--quiet", str(self.remote), f"+{tip}:refs/heads/main", f"+{head}:refs/pull/30/head")
        run("git", "--git-dir", str(self.remote), "update-server-info")

    def prepare_source(self):
        source = self.root / "source"
        for relative in ("vm", "lib"):
            shutil.copytree(REPOSITORY / relative, source / relative, ignore=shutil.ignore_patterns("__pycache__"))
        trust = self.root / "public.asc"
        trust.write_text(self.public_key(self.operator, self.operator_key) + self.public_key(self.factory, self.factory_key))
        settings = {"POTS_LANDING_KEY_HOME": str(self.factory), "POTS_LANDING_STATE": str(self.root / "state"), "POTS_SOURCE_URL": f"http://127.0.0.1:{self.server.server_port}/remote.git", "POTS_LANDING_REPOSITORY": "probe/factory", "POTS_TRUSTED_SIGNERS": str(trust), "POTS_SESSION_REPOSITORY": str(self.clone)}
        (source / "session").mkdir()
        (source / "session/launch.env").write_text("".join(f"{name}={value}\n" for name, value in settings.items()))
        self.source = source
        self.module = load_signer(source)

    def public_key(self, home, key):
        return run("gpg", "--no-options", "--homedir", str(home), "--armor", "--export", key) + "\n"

    def test_signed_squash_has_checked_base_and_tree(self):
        release = self.signer.sign(self.request)
        self.assertEqual(self.signer.git("show", "--no-patch", "--format=%P", release["commit"]), self.base)
        self.assertEqual(self.signer.git("show", "--no-patch", "--format=%T", release["commit"]), self.tree)
        self.assertEqual(self.module.require_signed(self.signer.store, release["commit"], self.signer.trust), self.factory_key)
        self.assertEqual(release["fingerprint"], self.factory_key)
        subject, _, provenance = self.signer.git("show", "--no-patch", "--format=%B", release["commit"]).partition("\n\n")
        self.assertEqual(subject, "Factory landing v1")
        self.assertEqual(json.loads(provenance), self.request)

    def test_caller_cannot_choose_tree_message_or_signature_payload(self):
        for name in ("message", "payload", "parents", "origin", "command"):
            with self.subTest(name=name), self.assertRaises(self.module.Refused):
                self.signer.sign({**self.request, name: "attacker controlled"})
        self.assertFalse(self.signer.receipt.exists())

    def test_an_untrusted_parent_cannot_be_promoted(self):
        unsigned = self.git("commit-tree", f"{self.head}^{{tree}}", "-p", self.base, "-m", "untrusted parent")
        merged = self.git("commit-tree", f"{self.head}^{{tree}}", "-p", unsigned, "-m", "untrusted child")
        self.publish(unsigned, merged)
        with self.assertRaisesRegex(self.module.Refused, "not a trusted signed tip"):
            self.signer.sign({**self.request, "base": unsigned, "head": merged})
        self.assertFalse(self.signer.receipt.exists())

    def test_changed_main_or_head_cannot_substitute_an_unchecked_release(self):
        changed = self.git("commit-tree", f"{self.base}^{{tree}}", "-p", self.base, "-m", "different head")
        self.publish(changed, self.head)
        with self.assertRaises(self.module.Refused):
            self.signer.sign(self.request)
        self.publish(self.base, changed)
        with self.assertRaises(self.module.Refused):
            self.signer.sign(self.request)
        self.assertFalse(self.signer.receipt.exists())

    def test_squash_must_match_the_checked_tree(self):
        with self.assertRaisesRegex(self.module.Refused, "differs from the checked head"):
            self.signer.sign({**self.request, "tree": self.git("rev-parse", f"{self.base}^{{tree}}")})
        self.assertFalse(self.signer.receipt.exists())

    def test_wrong_repository_or_target_never_reaches_signing(self):
        for key, value in (("repository", "other/repository"), ("ref", "refs/heads/other")):
            with self.subTest(key=key), self.assertRaisesRegex(self.module.Refused, "wrong repository or target ref"):
                self.signer.sign({**self.request, key: value})
        self.assertFalse(self.signer.receipt.exists())

    def test_repeated_request_returns_identical_object_after_restart(self):
        release = self.signer.sign(self.request)
        restarted = self.module.Signer()
        self.assertEqual(restarted.sign(self.request), release)

    def test_old_trusted_parent_cannot_replace_last_signed_release(self):
        self.signer.sign(self.request)
        with self.assertRaises(self.module.Refused):
            self.signer.sign({**self.request, "generation": self.request["generation"] + 1})


def load_signer(source):
    sys.modules.pop("launch", None)
    specification = importlib.util.spec_from_file_location("landing_probe", source / "vm/landing.py")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def run_release(fixture, shared_revision, scenario):
    policy = Path(__file__).resolve()
    shared = fixture.root / "review-source"
    shared.mkdir()
    for name in ("factory-records.mjs", "factory-review.mjs", "private-json.mjs"):
        (shared / name).write_text(run("git", "-C", str(REPOSITORY), "show", f"{shared_revision}:session/{name}") + "\n")
    (fixture.root / "request.json").write_text(json.dumps(fixture.request))
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("landing release fixture needs Node.js on PATH.")
    result = run(node, str(policy.with_name("landing-release.mjs")), str(fixture.root), str(shared), str(fixture.remote), str(fixture.clone),
                 str(policy), str(fixture.source), scenario, environment={**FIXED_ENVIRONMENT, "HOME": str(fixture.root)}, stderr=None)
    return json.loads(result) if result else None


def export_release(fixture, revision, output):
    result = run_release(fixture, revision, "complete")
    record = result["published"]
    release = record["release"]
    assert fixture.module.require_signed(fixture.remote, release["commit"], fixture.signer.trust) == fixture.factory_key
    output.mkdir()
    run("git", "--git-dir", str(fixture.remote), "bundle", "create", str(output / "candidate.bundle"), release["request"]["ref"],
        f"refs/pull/{release['request']['number']}/head")
    (output / "operator-public.asc").write_text(fixture.public_key(fixture.operator, fixture.operator_key))
    (output / "factory-public.asc").write_text(fixture.public_key(fixture.factory, fixture.factory_key))
    receipt = {"producerSource": run("git", "-C", str(REPOSITORY), "rev-parse", "HEAD"), "reviewSource": revision, "reviewId": result["reviewId"],
               "review": {key: value for key, value in record.items() if key != "release"},
               "candidate": {key: value for key, value in release.items() if key != "object"}}
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


def release_main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True, metavar="REVIEW_SOURCE")
    parser.add_argument("--export", type=Path)
    arguments = parser.parse_args()
    revision = run("git", "-C", str(REPOSITORY), "rev-parse", "--verify", f"{arguments.release}^{{commit}}")
    for scenario in ("retargeted", "moved", "ambiguous", "complete"):
        fixture = LandingPolicy()
        try:
            fixture.setUp()
            if scenario == "complete" and arguments.export:
                export_release(fixture, revision, arguments.export.resolve())
            else:
                run_release(fixture, revision, scenario)
            print(f"landing release fixture: {scenario} passed")
        finally:
            fixture.doCleanups()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--sign"]:
        print(json.dumps(load_signer(Path(sys.argv[2])).Signer().sign(json.load(sys.stdin))))
    elif "--release" in sys.argv[1:]:
        release_main()
    else:
        unittest.main(verbosity=2)
