from contextlib import contextmanager
import signal

from guards import Refused


class Termination:
    def __init__(self):
        self.isProtected = False
        self.isRequested = False
        self.previous = {}

    def __enter__(self):
        for number in (signal.SIGTERM, signal.SIGINT):
            self.previous[number] = signal.signal(number, self.request)
        return self

    def __exit__(self, *_):
        for number, handler in self.previous.items():
            signal.signal(number, handler)

    def request(self, *_):
        self.isRequested = True
        if not self.isProtected:
            raise Refused('termination requested. Retain the attempt for owner reconciliation.')

    @contextmanager
    def protect(self):
        if self.isRequested:
            raise Refused('termination requested before the next operation')
        self.isProtected = True
        try:
            yield
        finally:
            self.isProtected = False
        if self.isRequested:
            raise Refused('termination deferred until the operation outcome was journaled. Owner reconciliation required.')
