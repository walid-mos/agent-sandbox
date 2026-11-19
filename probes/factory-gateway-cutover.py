#!/usr/bin/env python3
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import runpy
import signal
import sqlite3
import unittest

probe = runpy.run_path(str(Path(__file__).with_name('factory-installed-receiver.py')))
from managed_update import Blocked

PAUSED_ARRIVAL = 'during-pause'
SWITCH_ARRIVAL = 'during-switch'


class GatewayFixture:
    def __init__(self, root):
        self.root = root
        self.path = root / 'disposable-gateway.sqlite'

    @contextmanager
    def transaction(self):
        with closing(sqlite3.connect(self.path)) as connection, connection:
            yield connection

    def initialize(self):
        with self.transaction() as connection:
            connection.executescript('''
                CREATE TABLE gate (active_hold TEXT, released_hold TEXT);
                INSERT INTO gate VALUES (NULL, NULL);
                CREATE TABLE inbox (event TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE deliveries (event TEXT NOT NULL, revision TEXT NOT NULL);
            ''')

    def pause(self, hold):
        with self.transaction() as connection:
            self.require_hold_slot(connection, hold)
            connection.execute('UPDATE gate SET active_hold = ?', (hold,))
            self.receive(connection, PAUSED_ARRIVAL)
        if (self.root / 'interrupt-pause').exists():
            os.kill(os.getpid(), signal.SIGKILL)
        if (self.root / 'pause-reply-lost').exists():
            raise Blocked('gateway-pause-unconfirmed')

    def require_hold_slot(self, connection, hold):
        active, released = connection.execute('SELECT active_hold, released_hold FROM gate').fetchone()
        if active not in (None, hold) or released == hold:
            raise Blocked('gateway-hold-conflict')

    def drain(self, hold):
        with self.transaction() as connection:
            self.require_paused(connection, hold)
        if (self.root / 'active-bot').exists():
            raise Blocked('gateway-drain-timeout')

    def require_paused(self, connection, hold=None):
        active, = connection.execute('SELECT active_hold FROM gate').fetchone()
        if active is None or (hold is not None and active != hold):
            raise Blocked('gateway-pause-unconfirmed')

    def observe_restart(self):
        with self.transaction() as connection:
            self.require_paused(connection)
            self.receive(connection, SWITCH_ARRIVAL)
            self.receive(connection, PAUSED_ARRIVAL)

    def receive(self, connection, event):
        connection.execute('INSERT OR IGNORE INTO inbox (event) VALUES (?)', (event,))

    def resume(self, hold):
        state = json.loads((self.root / 'receiver/control/status.json').read_text())
        revision = json.loads((self.root / 'container.json').read_text())['revision']
        if state['phase'] != 'resuming' or state['known_good'] != revision:
            raise Blocked('gateway-release-unconfirmed')
        if (self.root / 'resume-refused').exists():
            raise Blocked('gateway-resume-unconfirmed')
        with self.transaction() as connection:
            active, released = connection.execute('SELECT active_hold, released_hold FROM gate').fetchone()
            if active not in (None, hold):
                raise Blocked('gateway-hold-conflict')
            if released != hold:
                connection.execute('''INSERT INTO deliveries
                    SELECT event, ? FROM inbox WHERE event NOT IN (SELECT event FROM deliveries)''', (revision,))
                connection.execute('UPDATE gate SET active_hold = NULL, released_hold = ?', (hold,))
        if (self.root / 'resume-reply-lost').exists():
            raise Blocked('gateway-resume-unconfirmed')

    def snapshot(self):
        with self.transaction() as connection:
            active, = connection.execute('SELECT active_hold FROM gate').fetchone()
            arrivals = connection.execute('SELECT event FROM inbox ORDER BY event').fetchall()
            deliveries = connection.execute('SELECT event, revision FROM deliveries ORDER BY event').fetchall()
        return active, [event for (event,) in arrivals], deliveries


@unittest.skipUnless(os.environ.get('FACTORY_RELEASE_EXPORT'), 'provide the disposable #30 export')
class GatewayCutover(probe['InstalledFixture']):
    def setUp(self):
        super().setUp()
        self.gateway = GatewayFixture(self.root)
        self.gateway.initialize()
        code, state = self.outcome(self.installed_command('initialize-receiver'))
        self.assertEqual((code, state['loaded']), (0, self.installed))
        self.gateway_fixture = str(Path(__file__).resolve())

    def poll(self):
        return self.outcome(self.unit('update'))

    def mark(self, name):
        marker = self.root / name
        marker.touch()
        return marker

    def assert_delivered(self, revision, *arrivals):
        self.assertEqual(self.gateway.snapshot(), (None, sorted(arrivals), sorted((event, revision) for event in arrivals)))

    def assert_retained(self, *arrivals):
        active, queued, delivered = self.gateway.snapshot()
        self.assertIsNotNone(active)
        self.assertEqual((queued, delivered), (sorted(arrivals), []))

    def test_pauses_before_drain_and_retains_arrivals_once_on_success(self):
        code, state = self.poll()
        self.assertEqual((code, state['loaded']), (0, self.revision), state)
        self.assert_delivered(self.revision, PAUSED_ARRIVAL, SWITCH_ARRIVAL)
        self.assertEqual(self.starts(), [self.installed, self.revision])

    def test_drain_timeout_resumes_without_stopping_live_work(self):
        live = self.mark('active-bot')
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'gateway-drain-timeout', self.installed))
        self.assertTrue(live.exists())
        self.assertEqual(self.starts(), [self.installed])
        self.assert_delivered(self.installed, PAUSED_ARRIVAL)

    def test_worker_idle_check_remains_required_after_gateway_drain(self):
        self.mark('active-worker')
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'runtime-busy', self.installed))
        self.assertEqual(self.starts(), [self.installed])
        self.assert_delivered(self.installed, PAUSED_ARRIVAL)

    def test_pause_with_unknown_response_resumes_without_starting_candidate(self):
        self.mark('pause-reply-lost')
        code, state = self.poll()
        self.assertEqual((code, state['blocked'], state['loaded']), (1, 'gateway-pause-unconfirmed', self.installed))
        self.assertEqual(self.starts(), [self.installed])
        self.assert_delivered(self.installed, PAUSED_ARRIVAL)

    def test_interruption_during_pause_resumes_original_without_restart(self):
        self.mark('interrupt-pause')
        self.assertEqual(self.unit('update').returncode, -signal.SIGKILL)
        self.assert_retained(PAUSED_ARRIVAL)
        self.assertIn('admission-closed', self.unit('keeper').stderr)
        code, state = self.poll()
        self.assertEqual((code, state['phase'], state['loaded']), (1, 'ready', self.installed))
        self.assertEqual(self.starts(), [self.installed])
        self.assert_delivered(self.installed, PAUSED_ARRIVAL)

    def test_failed_candidate_resumes_original_only_after_rollback(self):
        self.mark(f'no-router-{self.revision}')
        code, state = self.poll()
        self.assertEqual((code, state['phase'], state['loaded']), (1, 'ready', self.installed))
        self.assert_delivered(self.installed, PAUSED_ARRIVAL, SWITCH_ARRIVAL)
        self.assertEqual(self.starts(), [self.installed, self.revision, self.installed])

    def test_failed_rollback_retains_arrivals_until_original_is_healthy(self):
        rollback_failure = self.root / f'no-router-{self.installed}'
        self.mark(f'interrupt-{self.revision}')
        self.assertEqual(self.unit('update').returncode, -signal.SIGKILL)
        rollback_failure.touch()
        code, state = self.poll()
        self.assertEqual((code, state['phase'], state['loaded']), (1, 'restoring', None))
        self.assert_retained(PAUSED_ARRIVAL, SWITCH_ARRIVAL)
        self.assertIn('admission-closed', self.unit('keeper').stderr)
        rollback_failure.unlink()
        code, state = self.poll()
        self.assertEqual((code, state['phase'], state['loaded']), (1, 'ready', self.installed))
        self.assert_delivered(self.installed, PAUSED_ARRIVAL, SWITCH_ARRIVAL)
        self.assertEqual(self.starts(), [self.installed, self.revision, self.installed, self.installed])

    def test_lost_resume_response_retries_same_release_without_restarting(self):
        lost = self.mark('resume-reply-lost')
        code, state = self.poll()
        self.assertEqual((code, state['phase'], state['loaded']), (1, 'resuming', None))
        self.assert_delivered(self.revision, PAUSED_ARRIVAL, SWITCH_ARRIVAL)
        self.assertIn('admission-closed', self.unit('keeper').stderr)
        lost.unlink()
        state = self.poll()[1]
        self.assertEqual((state['phase'], state['known_good'], state['loaded']), ('ready', self.revision, self.revision))
        self.assert_delivered(self.revision, PAUSED_ARRIVAL, SWITCH_ARRIVAL)
        self.assertEqual(self.starts(), [self.installed, self.revision])


if __name__ == '__main__':
    unittest.main(verbosity=2)
