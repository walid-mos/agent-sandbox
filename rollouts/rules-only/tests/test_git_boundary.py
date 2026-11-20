import os
from pathlib import Path
import shutil
import unittest

from fixture import Fixture, digest
from ownership import OwnedFixture


def tree_proof(root):
    return {str(path.relative_to(root)): (path.lstat().st_mode,
            str(path.readlink()) if path.is_symlink() else digest(path.read_bytes()))
            for path in root.rglob('*') if path.is_file() or path.is_symlink()}


class GitBoundaryTests(unittest.TestCase):
    def test_commondir_cannot_mutate_another_owned_repository(self):
        fixture = Fixture(self)
        other = Path(OwnedFixture(self).name) / 'repository'
        shutil.copytree(fixture.private, other)
        (fixture.private / '.git/commondir').write_text(str(other / '.git'))
        before = tree_proof(other)
        result = fixture.run()
        self.assertEqual(tree_proof(other), before)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(fixture.journal.exists())

    def test_redirected_metadata_and_mutation_directories_refuse(self):
        for redirect in ('gitdir', 'refs', 'objects', 'index', 'logs', 'alternate', 'shared-index', 'rules'):
            with self.subTest(redirect=redirect):
                self.check_redirect(redirect)

    def check_redirect(self, redirect):
        fixture = Fixture(self)
        other = Path(OwnedFixture(self).name) / 'repository'
        shutil.copytree(fixture.private, other)
        self.redirect(fixture.private, other, redirect)
        before = tree_proof(other)
        result = fixture.run()
        self.assertEqual(tree_proof(other), before)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(fixture.journal.exists())
        fixture.scratch.cleanup()

    def redirect(self, private, other, redirect):
        if redirect == 'alternate':
            (private / '.git/objects/info/alternates').write_text(str(other / '.git/objects') + '\n')
            return
        if redirect == 'shared-index':
            index = private / '.git/index'
            index.unlink()
            os.link(other / '.git/index', index)
            return
        relative = {'gitdir': '.git', 'rules': 'rules'}.get(redirect, '.git/' + redirect)
        target = private / relative
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        target.symlink_to(other / relative, target_is_directory=redirect != 'index')


if __name__ == '__main__':
    unittest.main()
