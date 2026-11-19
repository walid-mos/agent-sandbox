import json
from pathlib import Path
import runpy
import sys

source, root, service = sys.argv[1:]
sys.path.insert(0, str(Path(source) / 'lib'))
from factory_socket import REQUEST_LIMIT, Refused, serve


def report(request):
    path = Path(root) / 'reports.jsonl'
    previous = path.read_text().splitlines() if path.exists() else []
    for line in previous:
        recorded = json.loads(line)
        if recorded['id'] == request['id']:
            assert recorded == request
            return {}
    with path.open('a') as output:
        output.write(json.dumps(request) + '\n')
    lost = Path(root) / 'lose-report-response'
    if lost.exists():
        lost.unlink()
        raise Refused('fixture lost the report response')
    return {}


if service == 'landing':
    runpy.run_path(str(Path(source) / 'vm/landing-signer'))['serve_signer']()
else:
    serve(Path(root) / 'report/socket', 'reports', REQUEST_LIMIT, report, 'Disposable report service.')
