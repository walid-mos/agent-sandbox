#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

REPOSITORY = Path(__file__).resolve().parents[1]
FIXED_ENVIRONMENT = {"PATH": "/usr/bin:/bin", "LANG": "C", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_AUTHOR_NAME": "probe", "GIT_AUTHOR_EMAIL": "probe@invalid", "GIT_COMMITTER_NAME": "probe", "GIT_COMMITTER_EMAIL": "probe@invalid"}


def run(*arguments, input=None, environment=FIXED_ENVIRONMENT):
    return subprocess.check_output(arguments, input=input, env=environment, stderr=subprocess.DEVNULL).decode().strip()


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
        self.remote = self.root / "remote.git"
        run("git", "init", "--quiet", "--initial-branch=main", str(self.clone))
        self.git("commit", "--quiet", "--allow-empty", f"-S{self.operator_key}", "-m", "operator anchor", environment={**FIXED_ENVIRONMENT, "GNUPGHOME": str(self.operator)})
        self.base = self.git("rev-parse", "HEAD")
        (self.clone / "change").write_text("checked content\n")
        self.git("add", "change")
        self.git("commit", "--quiet", "-m", "checked head")
        self.head = self.git("rev-parse", "HEAD")
        self.merged = self.git("commit-tree", f"{self.head}^{{tree}}", "-p", self.base, "-m", "squash")
        run("git", "clone", "--quiet", "--bare", str(self.clone), str(self.remote))
        self.publish(self.merged, self.head)
        self.git("reset", "--quiet", "--hard", self.base)
        handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(self.root), **kwargs)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.prepare_source()
        self.signer = self.module.Signer()
        self.request = {"repository": self.signer.repository, "number": 30, "head": self.head, "base": self.base, "merged": self.merged}

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

    def publish(self, merged, head):
        self.git("push", "--quiet", str(self.remote), f"+{merged}:refs/heads/main", f"+{head}:refs/pull/30/head")
        run("git", "--git-dir", str(self.remote), "update-server-info")

    def prepare_source(self):
        source = self.root / "source"
        for relative in ("vm/landing.py", "lib/signed_commit.py", "lib/source_refresh.py"):
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPOSITORY / relative, target)
        trust = self.root / "public.asc"
        trust.write_text("\n".join(run("gpg", "--no-options", "--homedir", str(home), "--armor", "--export", key) for home, key in ((self.operator, self.operator_key), (self.factory, self.factory_key))))
        settings = {"POTS_LANDING_KEY_HOME": str(self.factory), "POTS_LANDING_STATE": str(self.root / "state"), "POTS_SOURCE_URL": f"http://127.0.0.1:{self.server.server_port}/remote.git", "POTS_TRUSTED_SIGNERS": str(trust), "POTS_SESSION_REPOSITORY": str(self.clone)}
        (source / "session").mkdir()
        (source / "session/launch.env").write_text("".join(f"{name}={value}\n" for name, value in settings.items()))
        specification = importlib.util.spec_from_file_location("landing_probe", source / "vm/landing.py")
        self.module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(self.module)

    def test_valid_job_creates_only_one_empty_signed_landing(self):
        release = self.signer.sign(self.request)
        self.assertEqual(self.signer.git("show", "--no-patch", "--format=%P", release["commit"]), self.merged)
        self.assertEqual(self.signer.git("diff-tree", "--no-commit-id", "--name-only", "-r", release["commit"]), "")
        self.assertEqual(self.module.require_signed(self.signer.store, release["commit"], self.signer.trust), self.factory_key)
        self.assertEqual(release["fingerprint"], self.factory_key)
        self.assertIn(f"Head: {self.head}", self.signer.git("show", "--no-patch", "--format=%B", release["commit"]))

    def test_caller_cannot_choose_tree_message_or_signature_payload(self):
        for name in ("tree", "message", "payload", "parents", "origin", "command"):
            with self.subTest(name=name), self.assertRaises(self.module.Refused):
                self.signer.sign({**self.request, name: "attacker controlled"})
        self.assertFalse(self.signer.receipt.exists())

    def test_an_untrusted_parent_cannot_be_promoted(self):
        unsigned = self.git("commit-tree", f"{self.head}^{{tree}}", "-p", self.base, "-m", "untrusted parent")
        merged = self.git("commit-tree", f"{self.head}^{{tree}}", "-p", unsigned, "-m", "untrusted child")
        self.publish(merged, self.head)
        with self.assertRaises(self.module.Refused):
            self.signer.sign({**self.request, "base": unsigned, "merged": merged})
        self.assertFalse(self.signer.receipt.exists())

    def test_changed_main_or_head_cannot_substitute_an_unchecked_release(self):
        changed = self.git("commit-tree", f"{self.base}^{{tree}}", "-p", self.base, "-m", "different head")
        self.publish(changed, self.head)
        with self.assertRaises(self.module.Refused):
            self.signer.sign(self.request)
        self.publish(self.merged, changed)
        with self.assertRaises(self.module.Refused):
            self.signer.sign(self.request)
        self.assertFalse(self.signer.receipt.exists())

    def test_squash_must_match_the_checked_tree(self):
        changed = self.git("commit-tree", f"{self.base}^{{tree}}", "-p", self.base, "-m", "changed squash")
        self.publish(changed, self.head)
        with self.assertRaises(self.module.Refused):
            self.signer.sign({**self.request, "merged": changed})
        self.assertFalse(self.signer.receipt.exists())

    def test_repeated_request_returns_identical_object_after_restart(self):
        release = self.signer.sign(self.request)
        restarted = self.module.Signer()
        self.assertEqual(restarted.sign(self.request), release)

    def test_old_trusted_parent_cannot_replace_last_signed_release(self):
        self.signer.sign(self.request)
        changed = self.git("commit-tree", f"{self.head}^{{tree}}", "-p", self.base, "-m", "rewound squash")
        self.publish(changed, self.head)
        with self.assertRaises(self.module.Refused):
            self.signer.sign({**self.request, "merged": changed})


if __name__ == "__main__":
    unittest.main(verbosity=2)
