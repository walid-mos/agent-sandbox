import json
from pathlib import Path
import runpy
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from guards import AREA, private_directory, read_json, require
from sources import prove_files
import os
import tempfile

root = private_directory(Path(sys.argv[1]))
require(root.parent == Path(tempfile.gettempdir()).resolve() and root.name.startswith('rules-only-'),
        'isolated fixture root required')
marker = read_json(root / 'fixture-owner.json')
require(marker['runId'] == root.name, 'fixture ownership differs')
os.kill(marker['pid'], 0)
require((root / 'installed').resolve().is_relative_to(root), 'fixture install escaped')
prove_files(root / 'vm', read_json(AREA / 'resources.json'))
sys.path.insert(0, str(root / 'vm/lib'))
import client_rules

fault = json.loads((root / 'fixture-options.json').read_bytes())['storeFault']
replace = client_rules.replace_file


def replace_with_failure(path, content, mode):
    if fault == f'{path.name}:before':
        raise OSError('synthetic VM write failure')
    replace(path, content, mode)
    if fault == f'{path.name}:after':
        raise OSError('synthetic VM write failure')


client_rules.replace_file = replace_with_failure
sys.argv = [str(root / 'vm/vm/store-config'), str(root / 'installed')]
runpy.run_path(sys.argv[0], run_name='__main__')
