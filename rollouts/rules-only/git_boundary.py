import os
from pathlib import Path
import stat

from guards import require

INDIRECTIONS = ('commondir', 'gitdir', 'config.worktree', 'worktrees',
                'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'refs/replace')


def prove_entry(path):
    info = path.lstat()
    require(info.st_uid == os.getuid() and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)),
            'Git metadata must be owned ordinary files and directories')
    require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1, 'shared Git metadata refused')


def prove_git_directory(checkout):
    checkout = Path(checkout)
    metadata = checkout / '.git'
    require(checkout.is_absolute() and checkout.resolve() == checkout
            and not metadata.is_symlink() and metadata.is_dir(), 'indirect Git directory refused')
    prove_entry(metadata)
    for directory, names, files in os.walk(metadata, followlinks=False):
        for name in (*names, *files):
            prove_entry(Path(directory) / name)
    require(not any((metadata / name).exists() for name in INDIRECTIONS), 'Git metadata indirection refused')
    require((metadata / 'HEAD').is_file() and (metadata / 'config').is_file(), 'ordinary Git checkout required')


def prove_fixture_git(arguments, root):
    require(arguments.count('-C') == 1 and not any(argument.startswith(('--git-dir', '--work-tree', '--namespace'))
                                                for argument in arguments), 'fixture Git target override refused')
    checkout = Path(arguments[arguments.index('-C') + 1])
    require(checkout.is_relative_to(root) and checkout.resolve().is_relative_to(root),
            'fixture Git target escaped ownership root')
    prove_git_directory(checkout)
