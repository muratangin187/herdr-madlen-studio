import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import remote
import bridge


class RemoteTests(unittest.TestCase):
    def test_worker_reads_exact_process_without_remote_hc(self):
        with tempfile.TemporaryDirectory() as temp:
            home=Path(temp);sid='11111111-2222-3333-4444-555555555555'
            (home/'.claude/sessions').mkdir(parents=True)
            (home/'.claude/projects/test').mkdir(parents=True)
            (home/f'.claude/sessions/{os.getpid()}.json').write_text(json.dumps({'sessionId':sid}))
            (home/f'.claude/projects/test/{sid}.jsonl').write_text(json.dumps({'type':'assistant','message':{'role':'assistant','content':[{'type':'text','text':'Remote fixture response'}]}})+'\n')
            folder=Path(remote.__file__).parent
            request=dict(address='t1',terminal={'foreground':{'pid':os.getpid()},'status':{'state':'idle'}},kind='claude',screen='',sources={n:(folder/n).read_text() for n in ('bridge.py','binding.py','images.py','clipboard.py')})
            result=subprocess.run([sys.executable,'-c',remote.WORKER],input=json.dumps(request),capture_output=True,text=True,env={**os.environ,'HOME':temp},timeout=10)
            data=json.loads(result.stdout)
            self.assertEqual(data['session'],sid)
            self.assertEqual(data['messages'][0]['text'],'Remote fixture response')
    def test_remote_snapshot_hides_permission_prompt(self):
        response=SimpleNamespace(returncode=0,stdout=json.dumps({'session':'s','status':'blocked','messages':[],'prompt':{'title':'Bash command'}}))
        with patch.object(bridge,'terminal',return_value=({'status':{'state':'blocked','kind':'permission'}},'claude',42)),patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0,stdout='{"text":""}')),patch.object(remote.subprocess,'run',return_value=response):
            self.assertNotIn('prompt',remote.snapshot('mbp/t1'))
    def test_send_targets_full_remote_address(self):
        data={'session':'s','status':'idle','process_pid':42}
        terminal=({'status':{'state':'idle'}},'claude',42)
        with patch.object(remote,'snapshot',return_value=data),patch.object(bridge,'terminal',return_value=terminal),patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as run:
            self.assertEqual(remote.send('box/t1','s','Hello'),{'ok':True})
            run.assert_called_once_with(['hc','send','--if','idle','box/t1','Hello'])
    def test_changed_session_or_process_never_sends(self):
        with patch.object(remote,'snapshot',return_value={'session':'new','status':'idle','process_pid':42}),patch.object(bridge.b,'run') as run:
            with self.assertRaisesRegex(ValueError,'Oturum'):remote.send('box/t1','old','Hello')
            run.assert_not_called()
        with patch.object(remote,'snapshot',return_value={'session':'s','status':'idle','process_pid':42}),patch.object(bridge,'terminal',return_value=({'status':{'state':'idle'}},'claude',43)),patch.object(bridge.b,'run') as run:
            with self.assertRaisesRegex(ValueError,'işlem'):remote.send('box/t1','s','Hello')
            run.assert_not_called()
    def test_invalid_addresses_and_images_never_execute(self):
        for address in ('box/t1/extra','box;bad/t1','/t1'):
            with self.assertRaises(ValueError):remote.split(address)
        with patch.object(remote,'snapshot') as snapshot:
            with self.assertRaisesRegex(ValueError,'görsel'):remote.send('box/t1','s','Hello',['a.png'])
            snapshot.assert_not_called()
