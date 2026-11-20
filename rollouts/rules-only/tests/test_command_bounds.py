import json
import os
from pathlib import Path
import signal
import sys
import unittest

from fixture import AREA
from ownership import OwnedFixture, process_identity

sys.path.insert(0, str(AREA))
from execute import bounded_reads
from guards import Commands, Refused

WAIT_CHILD = '''import json,os,pathlib,sys,time
status=pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'uid':os.getuid(),'start':status}))
time.sleep(30)
'''


class CommandBoundsTests(unittest.TestCase):
    def setUp(self):
        self.owned = OwnedFixture(self)
        self.root = Path(self.owned.name)
        self.marker = self.root / 'read-child.json'
        self.command = [sys.executable, '-I', '-c', WAIT_CHILD, str(self.marker)]

    def test_aggregate_deadline_stops_and_reaps_an_inflight_read_child(self):
        commands = Commands(20)
        commands.fixture_home = self.root
        self.assert_stopped(lambda: self.invoke_read(commands))

    def test_individual_command_deadline_stops_and_reaps_an_inflight_read_child(self):
        commands = Commands(1)
        commands.fixture_home = self.root
        self.assert_stopped(lambda: commands.run(self.command))

    def assert_stopped(self, action):
        try:
            with self.assertRaises(Refused):
                action()
            child = json.loads(self.marker.read_bytes())
            self.assertEqual(process_identity(child['pid']), 'ended')
        finally:
            self.stop_owned_child(self.marker)

    def invoke_read(self, commands):
        with bounded_reads(1):
            commands.run(self.command)

    def stop_owned_child(self, marker):
        if not marker.exists():
            return
        child = json.loads(marker.read_bytes())
        if child['uid'] != os.getuid() or process_identity(child['pid']) != child['start']:
            return
        os.killpg(child['pid'], signal.SIGKILL)
        os.waitpid(child['pid'], 0)


if __name__ == '__main__':
    unittest.main()
