import json
from pathlib import Path
import resource
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from repository_git import BUNDLE_LIMIT, GitCredentialRefused, GitFailure, git

MEMORY_LIMIT = 512 * 1024 * 1024
CPU_SECONDS = 60


def build_bundle(directory, repository, commits, token, run=git):
    directory = Path(directory)
    url = f'https://github.com/{repository}.git'
    run(directory, 'init', '--bare', '--quiet', '--initial-branch=main')
    run(directory, 'fetch', '--quiet', '--no-recurse-submodules', '--no-write-fetch-head', '--', url,
        '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', credential=(repository, token))
    for commit in dict.fromkeys(commits):
        fetch_commit(directory, url, repository, commit, token, run)
    bundle = directory / 'objects.bundle'
    run(directory, 'bundle', 'create', str(bundle), '--all')
    if bundle.stat().st_size > BUNDLE_LIMIT:
        raise GitFailure('Repository bundle exceeds the read size limit.')
    return bundle.read_bytes()


def fetch_commit(directory, url, repository, commit, token, run):
    try:
        run(directory, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--',
            url, f'{commit}:refs/repository-read/{commit}', credential=(repository, token))
        if run(directory, 'cat-file', '-t', commit).strip() != b'commit':
            raise GitFailure('Requested object is not a commit.')
    except GitCredentialRefused:
        raise
    except GitFailure:
        raise GitFailure(f'Commit {commit} is unavailable from the selected repository.') from None


def main():
    resource.setrlimit(resource.RLIMIT_FSIZE, (BUNDLE_LIMIT, BUNDLE_LIMIT))
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    try:
        request = json.load(sys.stdin)
        bundle = build_bundle(Path.cwd(), request['repository'], request['commits'], request['token'])
    except (GitFailure, OSError, ValueError, MemoryError) as error:
        message = str(error) if isinstance(error, GitFailure) else 'Repository read failed within its resource limits.'
        sys.stderr.write(message)
        return 1
    sys.stdout.buffer.write(bundle)
    return 0


if __name__ == '__main__':
    sys.exit(main())
