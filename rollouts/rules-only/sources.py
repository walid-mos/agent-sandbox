import sys
import types
from pathlib import Path

from guards import digest, regular, require


def prove_files(directory, resources):
    directory = Path(directory)
    require(directory.resolve() == directory and directory.is_dir(), 'source directory is symlinked or missing')
    for name, expected in resources['files'].items():
        require(digest(regular(directory / name).read_bytes()) == expected, 'incompatible source implementation')


def load_module(name, directory, resources):
    path = Path(directory) / 'lib' / f'{name}.py'
    content = regular(path).read_bytes()
    require(digest(content) == resources['files'][f'lib/{name}.py'], 'module changed after proof')
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(content, str(path), 'exec'), module.__dict__)
    return module


def prove_checkout(commands, contract, resources, is_fixture):
    checkout = Path(contract['checkout'])
    prove_files(checkout, resources)
    refresh = load_module('source_refresh', checkout, resources)
    keys = commands.git(checkout, 'config', '--local', '--name-only', '--list').splitlines()
    require(all(refresh.SAFE_CONFIG.fullmatch(key) for key in keys), 'unsupported Mac Git config')
    require(commands.git(checkout, 'branch', '--show-current') == 'main', 'Mac checkout must remain on main')
    expected = contract['sourceHead'] if is_fixture else resources['revision']
    require(contract['sourceHead'] == expected and commands.git(checkout, 'rev-parse', 'HEAD') == expected,
            'Mac source revision differs')
    require(not commands.git(checkout, 'status', '--porcelain', '--untracked-files=all'), 'Mac checkout is not clean')
    if not is_fixture:
        origin = commands.git(checkout, 'config', '--local', '--get', 'remote.origin.url')
        require(origin.removesuffix('.git') == 'https://github.com/walid-mos/agent-sandbox', 'Mac origin differs')
    rules = load_module('client_rules', checkout, resources)
    bundle = load_module('config_bundle', checkout, resources)
    return rules, bundle, refresh


def prove_private(commands, contract, resources, refresh, is_fixture):
    checkout = Path(contract['privateCheckout'])
    require(checkout.resolve() == checkout and (checkout / '.git').is_dir()
            and not (checkout / '.git').is_symlink(), 'private checkout missing or symlinked')
    keys = commands.git(checkout, 'config', '--local', '--name-only', '--list').splitlines()
    require(all(refresh.SAFE_CONFIG.fullmatch(key) for key in keys), 'unsupported private Git config')
    origin = commands.git(checkout, 'config', '--local', '--get', 'remote.origin.url')
    require(origin.removesuffix('.git') == resources['privateOrigin'].removesuffix('.git'), 'private origin differs')
    require(commands.git(checkout, 'branch', '--show-current') == 'main', 'private checkout must start on main')
    require(commands.git(checkout, 'rev-parse', 'HEAD') == contract['privateHead'], 'private HEAD differs')
    require(not commands.git(checkout, 'status', '--porcelain', '--untracked-files=all'), 'private checkout is not clean')
    require(not commands.git(checkout, 'for-each-ref', '--format=%(refname)',
                             f"refs/heads/{resources['privateBranch']}"), 'private task branch already exists')
    require(commands.git(checkout, 'config', '--local', '--get', 'user.name')
            and commands.git(checkout, 'config', '--local', '--get', 'user.email'), 'private local Git identity missing')
    if not is_fixture:
        commands.git(checkout, 'merge-base', '--is-ancestor', resources['sourceMerge'], 'HEAD')
        is_private = commands.run(['gh', 'api', 'repos/walid-mos/agent-pi-accor', '--jq', '.private'])
        require(is_private.strip() == b'true', 'source privacy is not confirmed')
    return origin


def plan_import(contract, resources, rules):
    private = Path(contract['privateCheckout'])
    before = regular(contract['original']).read_bytes()
    recipe = regular(private / 'rules/import.json').read_bytes()
    require(digest(before) == resources['inputSha256'] and len(before) == resources['inputBytes'], 'original differs')
    require(digest(recipe) == resources['recipeSha256'], 'recipe differs')
    after = rules.apply_recipe(before, rules.parse_json(recipe))
    rules.rules_text(after)
    require(digest(after) == resources['outputSha256'] and len(after) == resources['outputBytes'], 'recipe result differs')
    target = private / 'rules/AGENTS.md'
    directory = Path(contract['runtime']) / 'sandboxes/accor'
    require(target.parent.resolve() == target.parent and target.parent.is_dir(), 'canonical directory missing')
    for path in (target, directory / rules.SNAPSHOT_FILE, directory / rules.STATE_FILE):
        require(not path.exists() and not path.is_symlink(), 'import destination already exists')
    return before, after
