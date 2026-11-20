#!/usr/bin/env python3
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import sys

from usage_grants import enrolled_destination, grant_target, require_current_grant, validate_grant
from usage_state import DAY_NAME, FILE_LIMIT, STATE, UsageRefused, parse_object, private_directory, read_private, replace_file, schedule_owner, stored_host

PUBLISHER_REVISION = 'c28162911b5dfc539e20f26e22bb93359e31dbc1'
PUBLISHER = Path('/opt/pots-usage') / PUBLISHER_REVISION
PUBLISHER_ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/nonexistent'}
SHA256 = re.compile('[a-f0-9]{64}')


def publisher_args(state, host, day, grant):
    return ['pnpm', 'run', 'publish-day', '--host-id', host, '--enrollment', str(state / 'enrollment.json'),
            '--grant', str(grant), '--export', str(state / 'export'), '--day', day]


def invoke_publisher(state, host, day, grant):
    result = subprocess.run(publisher_args(state, host, day, grant), cwd=PUBLISHER, env=PUBLISHER_ENV,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=120, check=False)
    if result.returncode or not result.stdout.strip():
        raise UsageRefused('Publisher did not confirm delivery. Check the grant and export, or use trusted digest readback.')
    return parse_object(result.stdout.strip().splitlines()[-1])


def checked_receipt(receipt, host, day):
    if set(receipt) != {'hostId', 'day', 'sha256'} or receipt['hostId'] != host or receipt['day'] != day:
        raise UsageRefused('Expected a publisher receipt for the enrolled host and day.')
    if not isinstance(receipt['sha256'], str) or not SHA256.fullmatch(receipt['sha256']):
        raise UsageRefused('Expected a SHA-256 digest in the publisher receipt.')
    return receipt


def completed_day(day, now):
    if not DAY_NAME.fullmatch(day) or dt.date.fromisoformat(day) >= now.date():
        raise UsageRefused('Expected a completed UTC day.')
    return day


def publish_day(state, host, destination, grant, now, publish):
    day = completed_day(grant.stem, now)
    receipt_path = private_directory(state / 'receipts') / grant.name
    try:
        checked_receipt(parse_object(read_private(receipt_path)), host, day)
        return
    except FileNotFoundError:
        pass
    validate_grant(grant, destination, host, day, now)
    private_directory(state / 'export')
    receipt = checked_receipt(publish(state, host, day, grant), host, day)
    replace_file(receipt_path, (json.dumps(receipt) + '\n').encode(), 0o600)
    print(f'{day}: usage delivery confirmed.')


def publish_pending(state, now, publish):
    private_directory(state)
    if schedule_owner(state) != b'vm':
        return 0
    try:
        enrollment = read_private(state / 'enrollment.json')
    except FileNotFoundError:
        return 0
    host = stored_host(state)
    try:
        destination = enrolled_destination(enrollment, host)
    except UsageRefused as error:
        print(error, file=sys.stderr)
        return 1
    failed = False
    for grant in sorted(private_directory(state / 'grants').glob('*.json')):
        try:
            publish_day(state, host, destination, grant, now, publish)
        except UsageRefused as error:
            print(error, file=sys.stderr)
            failed = True
        except (OSError, ValueError, subprocess.TimeoutExpired):
            print('Usage day could not be processed safely.', file=sys.stderr)
            failed = True
    return int(failed)


def receive(state, arguments, now):
    host = stored_host(private_directory(state))
    content = sys.stdin.buffer.read(FILE_LIMIT + 1)
    if len(content) > FILE_LIMIT:
        raise UsageRefused('Usage file exceeds the size limit.')
    if arguments == ['enroll']:
        destination = enrolled_destination(content, host)
        enrollment = state / 'enrollment.json'
        try:
            previous = enrolled_destination(read_private(enrollment), host)
        except FileNotFoundError:
            previous = destination
        if previous != destination:
            raise UsageRefused('The VM is already enrolled for a different destination.')
        replace_file(enrollment, content, 0o600)
        return
    if len(arguments) != 2 or arguments[0] != 'grant':
        raise UsageRefused('Usage: usage_probe.py [enroll | grant YYYY-MM-DD]')
    day = completed_day(arguments[1], now)
    destination = enrolled_destination(read_private(state / 'enrollment.json'), host)
    require_current_grant(content, grant_target(destination, host, day), now)
    replace_file(private_directory(state / 'grants') / f'{day}.json', content, 0o600)


def main(arguments):
    now = dt.datetime.now(dt.timezone.utc)
    try:
        if arguments:
            receive(STATE, arguments, now)
            return 0
        return publish_pending(STATE, now, invoke_publisher)
    except UsageRefused as error:
        print(error, file=sys.stderr)
    except (OSError, ValueError):
        print('Usage state is unavailable or invalid. Check the VM provisioning and private file permissions.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
