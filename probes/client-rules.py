#!/usr/bin/env python3
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from client_rules import RulesRefused, SNAPSHOT_FILE, STATE_FILE, apply_recipe, digest, read_json
from client_rules_import import approve_rules, import_rules
from config_bundle import bundle

ROOT = Path(__file__).resolve().parents[1]

ORIGINAL = b"# Synthetic client\n\n## Safety\nKeep approval.\n\n## Tests\nAsk for every fixture.\n\n## Network\nUse a fixed listener.\n\n## Other\nKeep \xc3\xa9 and whitespace.  \n"
EXPECTED = b"# Synthetic client\n\n## Safety\nKeep approval.\n\n## Tests\nFollow the global fixture rule.\n\n## Network\nUse the allocated listener.\n\n## Other\nKeep \xc3\xa9 and whitespace.  \n"


def recipe():
    return {"inputSha256": digest(ORIGINAL), "replacements": [
        {"before": "Ask for every fixture.\n", "after": "Follow the global fixture rule.\n"},
        {"before": "Use a fixed listener.\n", "after": "Use the allocated listener.\n"},
    ]}


class RecipeTests(unittest.TestCase):
    def test_preserves_every_unrelated_byte(self):
        self.assertEqual(apply_recipe(ORIGINAL, recipe()), EXPECTED)

    def test_refuses_missing_repeated_overlapping_and_partial_anchors(self):
        for anchor in ["Missing.\n", "\n", "fixed listener.\n"]:
            changed = recipe()
            changed["replacements"][0]["before"] = anchor
            with self.assertRaises(RulesRefused):
                apply_recipe(ORIGINAL, changed)
        changed = recipe()
        changed["replacements"].append(changed["replacements"][0])
        with self.assertRaises(RulesRefused):
            apply_recipe(ORIGINAL, changed)

    def test_refuses_overlapping_occurrences_of_one_multiline_anchor(self):
        original = b"a\na\na\n"
        plan = {"inputSha256": digest(original), "replacements": [{"before": "a\na\n", "after": "b\n"}]}
        with self.assertRaises(RulesRefused):
            apply_recipe(original, plan)

    def test_refuses_wrong_hash_and_unknown_fields(self):
        for changed in [{**recipe(), "inputSha256": "0" * 64}, {**recipe(), "extra": True}]:
            with self.assertRaises(RulesRefused):
                apply_recipe(ORIGINAL, changed)

    def test_replacements_are_anchored_in_original_not_prior_output(self):
        changed = recipe()
        changed["replacements"][1]["before"] = "Follow the global fixture rule.\n"
        with self.assertRaises(RulesRefused):
            apply_recipe(ORIGINAL, changed)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="client-rules-proof-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        self.host = self.root / "host"
        self.source = self.root / "source"
        self.host.mkdir()
        self.source.mkdir()
        self.original = self.root / "AGENTS.md"
        self.original.write_bytes(ORIGINAL)
        self.plan = self.source / "import.json"
        self.plan.write_text(json.dumps(recipe()))
        self.recipe_hash = digest(self.plan.read_bytes())
        self.configuration = {"rules": "/etc/agent-sandbox/synthetic.md", "sources": ["synthetic"]}
        (self.host / "sandbox.json").write_text(json.dumps(self.configuration))
        (self.host / "vault.json").write_text('{}')

    def import_original(self):
        return import_rules(self.host, lambda source: self.source, "synthetic", self.original, "AGENTS.md", self.plan.name, self.recipe_hash)

    def test_import_links_original_to_approved_copy_and_keeps_one_source(self):
        state = self.import_original()
        self.assertEqual((self.source / "AGENTS.md").read_bytes(), EXPECTED)
        self.assertEqual(self.original.read_bytes(), EXPECTED)
        self.assertEqual(self.original.readlink(), self.host / SNAPSHOT_FILE)
        self.assertEqual(state["previousSha256"], digest(ORIGINAL))
        self.assertEqual((self.host / SNAPSHOT_FILE).stat().st_mode & 0o777, 0o444)
        self.assertEqual(bundle(self.host, self.root)["client-rules"]["text"].encode(), EXPECTED)

    def test_invalid_recipe_changes_no_file(self):
        for contents in ['{"inputSha256":"bad","replacements":[]}', '{"x":1,"x":2}', "not JSON"]:
            self.plan.write_text(contents)
            self.recipe_hash = digest(self.plan.read_bytes())
            with self.assertRaises(RulesRefused):
                self.import_original()
            self.assertEqual(self.original.read_bytes(), ORIGINAL)
            self.assertFalse(self.original.is_symlink())
            self.assertFalse((self.source / "AGENTS.md").exists())
            self.assertFalse((self.host / STATE_FILE).exists())
            self.assertFalse((self.host / SNAPSHOT_FILE).exists())

    def test_unapproved_recipe_changes_no_file(self):
        changed = recipe()
        changed["replacements"][0]["after"] = "A different rule.\n"
        self.plan.write_text(json.dumps(changed))
        with self.assertRaises(RulesRefused):
            self.import_original()
        self.assertEqual(self.original.read_bytes(), ORIGINAL)
        self.assertFalse((self.source / "AGENTS.md").exists())

    def test_existing_target_is_never_overwritten(self):
        target = self.source / "AGENTS.md"
        target.write_bytes(b"Existing canonical content.\n")
        with self.assertRaises(RulesRefused):
            self.import_original()
        self.assertEqual(target.read_bytes(), b"Existing canonical content.\n")
        self.assertEqual(self.original.read_bytes(), ORIGINAL)

    def test_unapproved_source_update_cannot_change_loaded_rules(self):
        self.import_original()
        candidate = b"# Synthetic reviewed update\n"
        (self.source / "AGENTS.md").write_bytes(candidate)
        self.assertEqual(self.original.read_bytes(), EXPECTED)
        self.assertEqual(bundle(self.host, self.root)["client-rules"]["sha256"], digest(EXPECTED))
        with self.assertRaises(RulesRefused):
            approve_rules(self.host, lambda source: self.source, "0" * 64)
        self.assertEqual(self.original.read_bytes(), EXPECTED)
        updated = approve_rules(self.host, lambda source: self.source, digest(candidate))
        self.assertEqual(self.original.read_bytes(), candidate)
        self.assertEqual(updated["previousSha256"], digest(EXPECTED))

    def test_unselected_source_and_corrupt_snapshot_are_refused(self):
        with self.assertRaises(RulesRefused):
            import_rules(self.host, lambda source: self.source, "unselected", self.original, "AGENTS.md", self.plan.name, self.recipe_hash)
        self.import_original()
        snapshot = self.host / SNAPSHOT_FILE
        snapshot.chmod(0o600)
        snapshot.write_bytes(b"An unapproved snapshot.\n")
        with self.assertRaises(RulesRefused):
            bundle(self.host, self.root)

    def cli_import(self, privacy):
        host = self.root / "sandboxes/synthetic"
        host.mkdir(parents=True, exist_ok=True)
        (host / "sandbox.json").write_text(json.dumps(self.configuration))
        executables = self.root / "bin"
        executables.mkdir()
        gh = executables / "gh"
        gh.write_text(f'#!/bin/sh\nprintf "{privacy}\\n"\n')
        gh.chmod(0o700)
        environment = {"HOME": str(self.root), "PATH": f"{executables}:/usr/bin:/bin", "SANDBOX": "synthetic",
                       "POTS_RUNTIME": str(self.root), "PYTHONDONTWRITEBYTECODE": "1"}
        bootstrap = "import runpy,sys; sys.path.insert(0,sys.argv.pop(1)+'/lib'); import client_rules_import; client_rules_import.source_catalog=lambda: {'synthetic': {'repository':'example/private-fixture','directory':'source'}}; sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')"
        return subprocess.run([sys.executable, "-c", bootstrap, str(ROOT), str(ROOT / "bin/client-rules"), "import", str(self.original),
                                 "--source", "synthetic", "--file", "rules/AGENTS.md", "--recipe", "rules/import.json",
                                 "--recipe-sha256", self.recipe_hash], env=environment, text=True, capture_output=True, check=False)

    def test_cli_refuses_public_source_before_import_without_logging_text(self):
        result = self.cli_import("false")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("privacy could not be confirmed", result.stderr)
        self.assertNotIn("Keep approval", result.stderr + result.stdout)
        self.assertEqual(self.original.read_bytes(), ORIGINAL)

    def test_catalog_privacy_does_not_allow_a_different_checkout_origin(self):
        checkout = self.source
        for arguments in [["init", "--quiet"], ["remote", "add", "origin", "https://github.com/example/public-fixture.git"]]:
            result = subprocess.run(["git", "-C", str(checkout), *arguments], capture_output=True, check=False)
            self.assertEqual(result.returncode, 0)
        host = self.root / "sandboxes/synthetic"
        host.mkdir(parents=True)
        (host / "sandbox.json").write_text(json.dumps({**self.configuration, "sources": ["synthetic"]}))
        (checkout / "rules").mkdir()
        (checkout / "rules/import.json").write_bytes(self.plan.read_bytes())
        result = self.cli_import("true")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checkout origin differs", result.stderr)
        self.assertFalse((checkout / "rules/AGENTS.md").exists())
        self.assertEqual(self.original.read_bytes(), ORIGINAL)

    def test_refuses_symlink_escape_without_touching_original(self):
        (self.source / "outside").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RulesRefused):
            import_rules(self.host, lambda source: self.source, "synthetic", self.original, "outside/new.md", self.plan.name, self.recipe_hash)
        self.assertEqual(self.original.read_bytes(), ORIGINAL)
        self.assertFalse((self.root / "new.md").exists())


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="store-rules-proof-")
        self.addCleanup(self.scratch.cleanup)
        self.directory = Path(self.scratch.name).resolve()
        self.target = self.directory / "synthetic.md"
        self.target.write_bytes(ORIGINAL)
        self.configuration = {"rules": str(self.target)}
        self.payload = {"sandbox.json": self.configuration, "vault.json": {}, "client-rules": {
            "text": EXPECTED.decode(), "sha256": digest(EXPECTED), "previousSha256": digest(ORIGINAL)}}

    def store(self, payload):
        return subprocess.run([sys.executable, "-B", str(ROOT / "vm/store-config"), str(self.directory)],
                              input=json.dumps(payload), text=True, capture_output=True, check=False)

    def test_store_installs_verified_rules_at_existing_configured_path(self):
        result = self.store(self.payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target.read_bytes(), EXPECTED)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.store(self.payload).returncode, 0)

    def test_store_refuses_symlink_target(self):
        other = self.directory / "other.md"
        other.write_bytes(ORIGINAL)
        self.target.unlink()
        self.target.symlink_to(other)
        result = self.store(self.payload)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(other.read_bytes(), ORIGINAL)
        self.assertFalse((self.directory / "sandbox.json").exists())

    def test_store_refuses_bad_hash_path_or_previous_bytes_before_any_mutation(self):
        attacks = []
        for key in ("sha256", "previousSha256"):
            attack = copy.deepcopy(self.payload)
            attack["client-rules"][key] = "0" * 64
            attacks.append(attack)
        attack = copy.deepcopy(self.payload)
        attack["sandbox.json"]["rules"] = str(self.directory / "nested/escape.md")
        attacks.append(attack)
        for attack in attacks:
            result = self.store(attack)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.target.read_bytes(), ORIGINAL)
            self.assertFalse((self.directory / "sandbox.json").exists())
            self.assertNotIn("Keep approval", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
