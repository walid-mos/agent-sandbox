import json
import os
from pathlib import Path
import selectors
import subprocess
import sys

from fixture import AREA, Fixture, digest
from ownership import process_identity


class InFlight:
    def __init__(self, case):
        self.fixture = Fixture(case)
        self.fixture.scratch.isHeld = True
        self.process = None
        self.release = None
        self.reader = None
        self.isReleased = False
        self.isFinished = False
        case.addCleanup(self.close)
        self.fixture.options['storeFault'] = 'wait-before-write'
        for name in ('store-ready', 'store-release'):
            os.mkfifo(self.fixture.root / name, 0o600)
        self.reader = os.open(self.fixture.root / 'store-ready', os.O_RDONLY | os.O_NONBLOCK)
        self.release = os.open(self.fixture.root / 'store-release', os.O_RDWR | os.O_NONBLOCK)
        self.process = subprocess.Popen(self.fixture.command(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with selectors.DefaultSelector() as waiter:
            waiter.register(self.reader, selectors.EVENT_READ)
            case.assertTrue(waiter.select(20), 'fixture store did not reach the owned gate')
        case.assertEqual(os.read(self.reader, 1), b'R')

    def inspect(self):
        fixture = self.fixture
        command = [sys.executable, '-I', str(AREA / 'run.py'), 'inspect', '--contract', str(fixture.contract_path),
                   '--contract-sha256', digest(fixture.contract_path.read_bytes())]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        if result.returncode:
            raise AssertionError(result.stderr)
        return json.loads(result.stdout)

    def release_store(self):
        if self.release is not None and not self.isReleased:
            os.write(self.release, b'G')
            self.isReleased = True

    def finish(self):
        self.release_store()
        output = self.process.communicate(timeout=20)
        self.wait_store()
        self.isFinished = True
        self.fixture.scratch.isHeld = False
        return output

    def wait_store(self):
        path = self.fixture.root / 'store-process.json'
        if not path.exists():
            return
        identity = json.loads(path.read_bytes())
        if process_identity(identity['pid']) != identity['start']:
            return
        descriptor = os.pidfd_open(identity['pid'])
        try:
            self.wait_descriptor(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.waitpid(identity['pid'], os.WNOHANG)
        except ChildProcessError:
            pass

    def wait_descriptor(self, descriptor):
        with selectors.DefaultSelector() as waiter:
            waiter.register(descriptor, selectors.EVENT_READ)
            if not waiter.select(20):
                raise AssertionError('owned fixture process did not end')

    def close(self):
        if self.process is not None and not self.isFinished:
            self.finish()
        for descriptor in (self.reader, self.release):
            if descriptor is not None:
                os.close(descriptor)
