"""Operational smoke confirmation regressions; run on Linux scratch only."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import driver as driver_module

from driver import Driver, StepFailed


FAKE_GIT = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
p = Path(os.environ['PROBE_STATE'])
s = json.loads(p.read_text())
args = sys.argv[3:]
if args[0] == 'commit':
    s['commits'] += 1
    s['head'] = '%040x' % s['commits']
elif args[0] == 'rev-parse':
    print(s['head'])
elif args[0] == 'ls-remote':
    s['queries'].append({'args': args, 'head': s['head']})
    p.write_text(json.dumps(s))
    mode = s['mode']
    if mode == 'reset' or (mode == 'once' and len(s['queries']) == 1):
        print('fatal: Recv failure: Connection reset by peer', file=sys.stderr)
        sys.exit(128)
    if mode == 'auth':
        print('fatal: Authentication failed', file=sys.stderr)
        sys.exit(128)
    if mode == 'auth-reset':
        print('fatal: Authentication failed; Connection reset by peer', file=sys.stderr)
        sys.exit(128)
    if mode == 'wrong-remote':
        print("fatal: 'origin' does not appear to be a git repository", file=sys.stderr)
        sys.exit(128)
    if mode == 'late':
        time.sleep(1.2)
    if mode == 'hang':
        time.sleep(2)
    if mode == 'different':
        print('f' * 40 + '\trefs/heads/main')
    else:
        print(s['head'] + '\trefs/heads/main')
p.write_text(json.dumps(s))
'''

NUDGE = r'''#!/usr/bin/env python3
import os, signal, time
if os.environ.get('STUBBORN_NUDGE') == '1':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(2)
'''


class RemoteConfirmationTests(unittest.TestCase):
    def run_smoke(self, mode, timeout=0.7, commits=1, stubborn=False):
        tmp = tempfile.TemporaryDirectory(prefix='smoke-confirm-')
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        probe = root / 'probe.json'
        probe.write_text(json.dumps({'mode': mode, 'commits': 0, 'head': '', 'queries': []}))
        for name, source in [('git', FAKE_GIT), ('vault', NUDGE)]:
            (root / name).write_text(source)
            (root / name).chmod(0o755)
        clone = root / 'clone'
        clone.mkdir()
        config = {'workDir': str(root / 'work'), 'mode': 'secondary',
                  'mac': {'newClone': str(clone), 'git': str(root / 'git'), 'vault': [str(root / 'vault')]},
                  'server': {'tree': ''},
                  'env': {'PROBE_STATE': str(probe), 'STUBBORN_NUDGE': '1' if stubborn else '0'},
                  'smoke': {'planFile': None, 'logFile': 'smoke.md', 'commits': commits,
                            'syncTimeout': timeout, 'blobPath': None, 'bigPath': None, 'rejectPath': None}}
        cp = root / 'config.json'
        cp.write_text(json.dumps(config))
        driver = Driver(str(cp))
        driver.state = {'values': {'freezeId': 'synthetic'}, 'steps': {}}
        driver.wait_daemon = lambda *_: (True, {'pid': 123})
        driver.vault = lambda *a, **k: (0, (clone / 'smoke.md').read_text())
        started = time.monotonic()
        error = None
        try:
            driver.step_12()
        except StepFailed as exc:
            error = str(exc)
        return driver.values()['smoke']['commits'], json.loads(probe.read_text()), time.monotonic() - started, error

    def test_single_reset_then_same_commit_succeeds(self):
        result, state, _, error = self.run_smoke('once', timeout=1.5)
        self.assertIsNone(error)
        self.assertTrue(result['ok'])
        self.assertEqual(state['commits'], 1)
        self.assertEqual(len(state['queries']), 2)
        self.assertEqual(state['queries'][0], state['queries'][1])
        receipt = result['confirmations'][0]
        self.assertEqual(receipt['retries'], 1)
        self.assertIn('Connection reset by peer', receipt['attempts'][0]['stderr'])

    def test_persistent_reset_expires_without_new_commit(self):
        result, state, elapsed, error = self.run_smoke('reset')
        self.assertIsNotNone(error)
        self.assertFalse(result['ok'])
        self.assertIn('deadline', result['error'])
        self.assertGreater(len(state['queries']), 1)
        self.assertEqual(state['commits'], 1)
        self.assertLess(elapsed, 1.3)

    def test_hanging_query_and_late_matching_response_fail_within_budget(self):
        for mode in ('hang', 'late'):
            with self.subTest(mode=mode):
                result, _, elapsed, error = self.run_smoke(mode, timeout=0.3)
                self.assertIsNotNone(error)
                self.assertFalse(result['ok'])
                self.assertLess(elapsed, 0.9)

    def test_nontransient_errors_fail_once(self):
        for mode in ('auth', 'auth-reset', 'wrong-remote'):
            with self.subTest(mode=mode):
                result, state, elapsed, error = self.run_smoke(mode)
                self.assertIsNotNone(error)
                self.assertFalse(result['ok'])
                self.assertEqual(len(state['queries']), 1)
                self.assertLess(elapsed, 0.6)

    def test_different_remote_head_does_not_pass(self):
        result, _, elapsed, error = self.run_smoke('different', timeout=0.3)
        self.assertIsNotNone(error)
        self.assertFalse(result['ok'])
        self.assertLess(elapsed, 0.9)

    def test_nudge_wait_cannot_extend_deadline(self):
        result, _, elapsed, error = self.run_smoke('ok', timeout=0.3, stubborn=True)
        self.assertIsNotNone(error)
        self.assertFalse(result['ok'])
        self.assertLess(elapsed, 0.9)

    def test_matching_response_processed_after_deadline_is_not_success(self):
        real_popen = driver_module.subprocess.Popen

        def delayed_response(args, **kwargs):
            process = real_popen(args, **kwargs)
            if 'ls-remote' in args:
                communicate = process.communicate

                def delayed(*a, **k):
                    result = communicate(*a, **k)
                    time.sleep(0.4)  # scheduling delay after the successful process exits
                    return result
                process.communicate = delayed
            return process

        with patch('driver.subprocess.Popen', delayed_response):
            result, _, _, error = self.run_smoke('ok', timeout=0.3)
        self.assertIsNotNone(error)
        self.assertFalse(result['ok'])

    def test_all_ten_new_commits_are_confirmed(self):
        result, state, _, error = self.run_smoke('ok', commits=10)
        self.assertIsNone(error)
        self.assertTrue(result['ok'])
        self.assertEqual(state['commits'], 10)
        self.assertEqual(len(result['latencies']), 10)
        self.assertEqual(len({q['head'] for q in state['queries']}), 10)
        self.assertTrue(all(q['args'] == ['ls-remote', 'origin', 'refs/heads/main'] for q in state['queries']))


if __name__ == '__main__':
    unittest.main()
