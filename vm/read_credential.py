import os
import sys


def answer(action, text, environment):
    if action != 'get':
        return ''
    fields = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    repository = environment.get('REPOSITORY_READ_KEY', '')
    token = environment.get('REPOSITORY_READ_TOKEN', '')
    if fields.get('protocol') != 'https' or fields.get('host') != 'github.com' or fields.get('path') != f'{repository}.git':
        return ''
    if not repository or not token or any(character in token for character in '\r\n\0'):
        return ''
    return f'username=x-access-token\npassword={token}\n\n'


if __name__ == '__main__':
    sys.stdout.write(answer(sys.argv[1] if len(sys.argv) == 2 else '', sys.stdin.read(4096), os.environ))
