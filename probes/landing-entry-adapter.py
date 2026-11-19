#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(os.environ['LANDING_TEST_ROOT'])
ORIGIN = ROOT / 'served/remote.git'
REPOSITORY = 'probe/factory'


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--git-dir', str(ORIGIN), *args], text=True).strip()


def emit(value):
    print(json.dumps(value))


def log(name, value):
    with (ROOT / name).open('a') as output:
        output.write(json.dumps(value) + '\n')


def merge(pull, args):
    head = pull['headRefOid']
    assert args[args.index('--match-head-commit') + 1] == head
    assert pull['state'] == 'OPEN' and pull['baseRefName'] == 'main' and not pull['isDraft']
    base = git('rev-parse', 'refs/heads/main')
    race = ROOT / 'race'
    if race.exists():
        review = race.read_text().strip()
        race.unlink()
        subprocess.run([os.environ['LANDING_TEST_NODE'], '--import', str(ROOT / 'loader.mjs'),
                        str(ROOT / 'source/session/factory.mjs'), 'review', review, 'verdict', 'PASS'], check=True)
        base = git('rev-parse', 'refs/heads/main')
    tree = git('merge-tree', '--write-tree', base, head)
    squash = git('commit-tree', tree, '-p', base, '-m', f"squash {pull['number']}")
    git('update-ref', 'refs/heads/main', squash, base)
    git('update-server-info')
    (ROOT / f"pull-{pull['number']}.json").write_text(json.dumps({**pull, 'state': 'MERGED', 'mergeCommit': {'oid': squash}}))
    log('merges.jsonl', squash)
    return 1 if (ROOT / 'lose-merge-response').exists() else 0


def github(args):
    if args[:2] == ['repo', 'list']:
        emit([{'nameWithOwner': REPOSITORY, 'repositoryTopics': [{'name': 'factory'}]}])
    elif args[:2] == ['api', 'graphql']:
        emit([{'data': {'repository': {'pullRequests': {'nodes': []}}}}])
    elif args[:2] == ['api', f'repos/{REPOSITORY}']:
        emit(['factory'])
    elif args[:2] == ['pr', 'list']:
        pulls = [json.loads(file.read_text()) for file in sorted(ROOT.glob('pull-*.json'))]
        emit([pull for pull in pulls if pull['state'] == 'OPEN'])
    else:
        return pull_operation(args)
    return 0


def pull_operation(args):
    number = args[1].rsplit('/', 1)[1] if args[0] == 'api' else args[2]
    assert number.isdigit(), args
    pull = json.loads((ROOT / f'pull-{number}.json').read_text())
    if args[0] == 'api':
        emit({'number': pull['number'], 'state': 'closed' if pull['state'] == 'MERGED' else 'open',
              'merged': pull['state'] == 'MERGED', 'head': {'sha': pull['headRefOid']},
              'base': {'ref': pull['baseRefName'], 'repo': {'full_name': REPOSITORY}},
              'merge_commit_sha': pull.get('mergeCommit', {}).get('oid')})
    elif args[1] == 'view':
        emit(pull)
    elif args[1] == 'merge':
        return merge(pull, args)
    else:
        assert args[1] == 'comment', args
    return 0


def docker(args):
    if args[:2] == ['image', 'inspect'] or args[:2] == ['run', '--rm'] and '/factory/attacks.sh' in args:
        return 0
    assert args[0] == 'run' and args[-3:-1] == ['sh', 'check-fixture.sh'], args
    volume = args[args.index('--volume') + 1].removesuffix(':/work')
    work = Path(volume) / 'repository'
    head = subprocess.check_output(['/usr/bin/git', '-C', str(work), 'rev-parse', 'HEAD'], text=True).strip()
    assert work.is_relative_to(ROOT)
    log('checks.jsonl', {'head': head, 'base': args[-1]})
    return subprocess.run(['/bin/sh', 'check-fixture.sh', args[-1]], cwd=work, check=False).returncode


if __name__ == '__main__':
    binary = Path(sys.argv[0]).name
    if binary == 'pots':
        log('wakes.jsonl', json.loads(sys.argv[-1]))
    else:
        raise SystemExit({'gh': github, 'docker': docker}[binary](sys.argv[1:]))
