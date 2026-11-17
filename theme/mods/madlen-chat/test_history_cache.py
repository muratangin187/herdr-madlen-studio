import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import bridge
import history_cache as cache


class HistoryCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        home = patch.object(cache.images, 'HOME', self.root)
        home.start(); self.addCleanup(home.stop)
        self.terminal = dict(created_ms=1, pid=10, foreground=dict(pid=20, argv=['codex']))
        self.data = dict(terminal='xps/t1', session='s', kind='codex', status='working', more=False,
                         messages=[dict(id='a', role='assistant', text='Hello', turn_status='inProgress')],
                         prompt=dict(fingerprint='old-permission'))

    def save(self, address='xps/t1', limit=40):
        cache.save(address, limit, self.terminal, 'codex', dict(self.data, terminal=address))

    def test_durable_cache_separates_machine_process_and_page(self):
        self.save()
        self.assertEqual(cache.load('xps/t1', 40, self.terminal, 'codex'), self.data)
        for address, limit in [('other/t1', 40), ('t1', 40), ('xps/t1', 80)]:
            self.assertIsNone(cache.load(address, limit, self.terminal, 'codex'))
        changed = copy.deepcopy(self.terminal); changed['foreground']['pid'] = 21
        self.assertIsNone(cache.load('xps/t1', 40, changed, 'codex'))
        changed = dict(self.terminal, created_ms=2)
        self.assertIsNone(cache.load('xps/t1', 40, changed, 'codex'))

    def test_warm_read_never_runs_a_remote_worker_or_replays_permissions(self):
        self.save()
        with patch.object(bridge, 'terminal', return_value=(self.terminal, 'codex', 20)), \
             patch.object(bridge, 'resolve', side_effect=AssertionError('No full binding/SSH')):
            result = bridge.cached('xps/t1', 40)
        self.assertTrue(result['cached'])
        self.assertIsNone(result['prompt'])
        self.assertEqual(result['messages'], self.data['messages'])

    def test_corruption_version_expiry_and_disk_failure_are_cache_misses(self):
        self.save(); path = cache.location('xps/t1', 40)
        path.write_text('{partial')
        self.assertIsNone(cache.load('xps/t1', 40, self.terminal, 'codex'))
        self.save()
        with patch.object(cache, 'VERSION', 99):
            self.assertIsNone(cache.load('xps/t1', 40, self.terminal, 'codex'))
        os.utime(path, (1, 1))
        self.assertIsNone(cache.load('xps/t1', 40, self.terminal, 'codex'))
        with patch.object(cache.os, 'replace', side_effect=OSError('disk full')):
            self.save()
        self.assertEqual(list(path.parent.iterdir()), [path], 'failed atomic writes leave no temporary transcript')

    def test_cache_permissions_bounds_and_unchanged_poll_do_not_rewrite(self):
        self.save(); path = cache.location('xps/t1', 40)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        before = path.stat().st_mtime_ns; self.save()
        self.assertEqual(path.stat().st_mtime_ns, before)
        with patch.object(cache, 'MAX_FILES', 2):
            self.save('xps/t2'); self.save('xps/t3')
        self.assertEqual(len(list(path.parent.glob('*.json'))), 2)

    def test_delta_updates_prior_completion_and_preserves_order_and_deletions(self):
        old = copy.deepcopy(self.data)
        old['messages'].append(dict(id='removed', role='tool', text='old'))
        new = copy.deepcopy(self.data)
        new['messages'][0].update(turn_status='completed', duration_ms=3000, final_id='final')
        new['messages'].append(dict(id='final', role='assistant', text='Done'))
        new['status'] = 'done'
        delta = cache.delta(new, cache.known(old))
        self.assertNotIn('messages', delta)
        self.assertEqual(cache.merge(delta, old), new)
        unchanged = cache.delta(new, cache.known(new))
        self.assertEqual(unchanged['delta']['changed'], [])
        self.assertEqual(cache.merge(unchanged, new), new)
        with self.assertRaises(ValueError):
            cache.merge(delta, dict(old, session='another-session'))

    def test_new_session_and_duplicate_ids_use_a_full_snapshot(self):
        new = dict(self.data, session='new')
        self.assertEqual(cache.delta(new, cache.known(self.data)), new)
        duplicate = dict(self.data, messages=self.data['messages'] * 2)
        self.assertIsNone(cache.known(duplicate))
        self.assertEqual(cache.delta(duplicate, cache.known(self.data)), duplicate)
