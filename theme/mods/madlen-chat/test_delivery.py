from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import bridge
import remote


class DeliveryTests(unittest.TestCase):
    def test_pre_send_validation_is_explicitly_safe_to_retry(self):
        output=io.StringIO()
        with patch('sys.argv',['bridge.py','--terminal','t1','--session','old','--text','Hello']), \
             patch.object(bridge,'resolve',side_effect=ValueError('Oturum değişti')), \
             patch.object(bridge.b,'run') as send,redirect_stdout(output):
            self.assertEqual(bridge.main(),1)
        self.assertEqual(json.loads(output.getvalue())['delivery'],'not_sent')
        send.assert_not_called()

    def test_local_timeout_after_submission_is_not_retryable(self):
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'idle'}},'codex','s',Path('/tmp'),True)), \
             patch.object(bridge.b,'run',side_effect=subprocess.TimeoutExpired('hc',8)) as send:
            result=bridge.send('t1','s','Hello')
        self.assertEqual(result['delivery'],'uncertain')
        send.assert_called_once()
        self.assertIn('Terminal',result['error'])

    def test_nonzero_transport_result_is_not_reported_as_unsent(self):
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'idle'}},'codex','s',Path('/tmp'),True)), \
             patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=1,stderr='Disconnected')):
            result=bridge.send('t1','s','Hello')
        self.assertEqual(result['delivery'],'uncertain')

    def test_remote_timeout_after_submission_never_retries(self):
        data={'session':'s','status':'idle','process_pid':42}
        with patch.object(remote,'snapshot',return_value=data), \
             patch.object(bridge,'terminal',return_value=({'status':{'state':'idle'}},'codex',42)), \
             patch.object(bridge.b,'run',side_effect=subprocess.TimeoutExpired('hc',8)) as send:
            result=remote.send('xps/t1','s','Hello')
        self.assertEqual(result['delivery'],'uncertain')
        send.assert_called_once_with(['hc','send','--if','idle','xps/t1','Hello'])
