import datetime as dt
import re
from urllib.parse import parse_qs, urlsplit

from usage_state import UsageRefused, parse_object, read_private

R2_ORIGIN = re.compile(r'https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com')
BUCKET = re.compile('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]')
SIGNING_TIME = '%Y%m%dT%H%M%SZ'
MAX_GRANT_SECONDS = 7 * 24 * 60 * 60


def enrolled_destination(content, host):
    enrollment = parse_object(content)
    if set(enrollment) != {'hostId', 'endpoint', 'bucket'} or enrollment['hostId'] != host:
        raise UsageRefused('Enrollment must match the provisioned usage identity.')
    endpoint, bucket = enrollment['endpoint'], enrollment['bucket']
    if not isinstance(endpoint, str) or not R2_ORIGIN.fullmatch(endpoint):
        raise UsageRefused('Expected an enrolled R2 HTTPS account origin.')
    if not isinstance(bucket, str) or not BUCKET.fullmatch(bucket):
        raise UsageRefused('Expected an enrolled R2 bucket.')
    return f'{endpoint}/{bucket}'


def require_current_grant(content, target, now):
    raw = parse_object(content).get('url')
    if not isinstance(raw, str) or raw.partition('?')[0] != target or '#' in raw:
        raise UsageRefused('Grant must target the exact enrolled host and day.')
    try:
        query = parse_qs(urlsplit(raw).query, keep_blank_values=True)
        signed, = query['X-Amz-Date']
        lifetime, = query['X-Amz-Expires']
        start = dt.datetime.strptime(signed, SIGNING_TIME).replace(tzinfo=dt.timezone.utc)
        seconds = int(lifetime)
    except (ValueError, KeyError):
        raise UsageRefused('Grant must have one valid signing time and expiry.') from None
    if start.strftime(SIGNING_TIME) != signed or not 0 < seconds <= MAX_GRANT_SECONDS:
        raise UsageRefused('Grant must have one valid signing time and expiry.')
    if not 0 <= (now - start).total_seconds() < seconds:
        raise UsageRefused('Grant is expired or not yet valid.')


def grant_target(destination, host, day):
    return f'{destination}/usage/v1/{host}/{day}.json'


def validate_grant(path, destination, host, day, now):
    require_current_grant(read_private(path), grant_target(destination, host, day), now)
