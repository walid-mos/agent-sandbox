import subprocess
import sys

from guards import AREA, MAX_BYTES, require
from journal import encode_line
from mutation_records import new_operation, read, store
from process_state import identity


class MutationLauncher:
    def __init__(self, journal, fixture_root):
        self.journal = journal
        self.fixture_root = str(fixture_root) if fixture_root else ''

    def run(self, arguments, input_bytes, environment):
        directory = new_operation(self.journal)
        worker = [sys.executable, '-I', str(AREA / 'run.py'), '_mutation-worker', str(directory)]
        process = subprocess.Popen(worker, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=environment, start_new_session=True)
        supervisor = identity(process.pid)
        require(supervisor['state'] == 'present' and supervisor['group'] == process.pid
                and supervisor['session'] == process.pid, 'mutation supervisor identity unavailable')
        store(directory, 'supervisor.json', {'identity': supervisor})
        request = {'arguments': list(map(str, arguments)), 'fixtureRoot': self.fixture_root}
        output, _ = process.communicate(encode_line(request) + input_bytes)
        outcome = read(directory, 'outcome.json')
        require(process.returncode == 0 and outcome['returncode'] == 0 and outcome['localGroupEnded'] is True
                and outcome['identity'] == supervisor and len(output) <= MAX_BYTES,
                'mutation command did not confirm completion. Output withheld. Owner reconciliation required.')
        return output
