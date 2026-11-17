import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import bridge
import remote


class StartupQueueTests(unittest.TestCase):
    def setUp(self):
        capability=patch.object(bridge,'claude_send_now_supported',return_value=True)
        capability.start();self.addCleanup(capability.stop)

    def terminal(self,kind='codex',state='idle',pid=42):
        return dict(created_ms=100,pid=10,foreground=dict(pid=pid,argv=[kind]),status=dict(state=state,app=kind))

    def test_unbound_process_is_a_valid_first_message_target_without_guessing_a_log(self):
        t=self.terminal()
        with tempfile.TemporaryDirectory() as folder,patch.object(bridge.images,'HOME',Path(folder)), \
             patch.object(bridge,'resolve',side_effect=bridge.UnboundSession(t,'codex')):
            data=bridge.snapshot('t1',40)
            self.assertTrue(data['unbound']);self.assertEqual(data['messages'],[])
            self.assertEqual(data['session'],bridge.process_key(t,'codex'))
            with patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as send:
                self.assertEqual(bridge.send('t1',data['session'],'First message'),{'ok':True})
                send.assert_called_once_with(['hc','send','--if','idle','t1','First message'])

    def test_startup_handle_can_transition_to_its_exact_live_session(self):
        t=self.terminal()
        with patch.object(bridge,'resolve',return_value=(t,'codex','new-session',Path('/tmp'),True)), \
             patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as send:
            self.assertEqual(bridge.send('t1',bridge.process_key(t,'codex'),'First'),{'ok':True})
            send.assert_called_once()

    def test_owned_codex_rollout_keeps_the_canonical_session_when_projection_appears(self):
        sid='11111111-2222-3333-4444-555555555555';t=self.terminal()
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/('rollout-date-'+sid+'.jsonl')
            path.write_text(json.dumps(dict(type='session_meta',payload=dict(id=sid)))+'\n')
            with patch.object(bridge,'terminal',return_value=(t,'codex',42)), \
                 patch.object(bridge.b,'codex_thread',return_value=None),patch.object(bridge.b,'exact_log',return_value=path), \
                 patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0,stdout='{"text":""}')):
                result=bridge.resolve('t1')
                self.assertEqual(result[2],sid);self.assertFalse(result[4])

    def test_startup_never_types_into_a_replaced_or_blocked_process(self):
        original=self.terminal()
        for changed in (self.terminal(pid=43),self.terminal(state='blocked')):
            with patch.object(bridge,'resolve',side_effect=bridge.UnboundSession(changed,'codex')),patch.object(bridge.b,'run') as send:
                with self.assertRaises(ValueError):bridge.send('t1',bridge.process_key(original,'codex'),'Do work')
                send.assert_not_called()

    def test_codex_steer_uses_native_enter_and_never_interrupts(self):
        t=self.terminal(state='working')
        with patch.object(bridge,'resolve',return_value=(t,'codex','s',Path('/tmp'),True)), \
             patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as send:
            self.assertEqual(bridge.send('t1','s','Correction',mode='steer'),{'ok':True})
            send.assert_called_once_with(['hc','send','--if','working','t1','Correction'])

    def test_claude_steer_uses_send_now_chord_after_verified_delivery(self):
        t=self.terminal('claude','working')
        with patch.object(bridge,'resolve',return_value=(t,'claude','s',Path('/tmp'),False)), \
             patch.object(bridge,'terminal',return_value=(t,'claude',42)), \
             patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as send:
            self.assertEqual(bridge.send('t1','s','Correction',mode='steer'),{'ok':True})
            self.assertEqual([c.args[0] for c in send.call_args_list],[
                ['hc','send','--if','working','t1','Correction'],['hc','keys','t1','ctrl+x','ctrl+s']])

    def test_claude_state_change_never_sends_a_key_into_a_permission_prompt(self):
        original=self.terminal('claude','working')
        for changed in (self.terminal('claude','blocked'),self.terminal('claude','working',43)):
            with patch.object(bridge,'resolve',return_value=(original,'claude','s',Path('/tmp'),False)), \
                 patch.object(bridge,'terminal',return_value=(changed,'claude',changed['foreground']['pid'])), \
                 patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as send:
                result=bridge.send('t1','s','Correction',mode='steer')
                self.assertTrue(result['ok']);self.assertIn('steer_error',result)
                self.assertEqual(send.call_count,1,'never resend an accepted message or send a key after a state change')

    def test_remote_normal_and_steer_preserve_the_full_machine_address(self):
        for kind in ('codex','claude'):
            t=self.terminal(kind,'working');data=dict(session='s',status='working',process_pid=42)
            with patch.object(remote,'snapshot',return_value=data),patch.object(bridge,'terminal',return_value=(t,kind,42)), \
                 patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as send:
                self.assertEqual(remote.send('xps/t1','s','Next'),dict(deferred=True,delivery='not_sent'))
                send.assert_not_called()
                self.assertTrue(remote.send('xps/t1','s','Correction',mode='steer')['ok'])
                self.assertEqual(send.call_args_list[0].args[0],['hc','send','--if','working','xps/t1','Correction'])
                if kind=='claude':self.assertEqual(send.call_args_list[1].args[0],['hc','keys','xps/t1','ctrl+x','ctrl+s'])

    def test_steer_failure_does_not_send_a_followup_key_or_invite_a_duplicate(self):
        t=self.terminal('claude','working')
        with patch.object(bridge,'resolve',return_value=(t,'claude','s',Path('/tmp'),False)), \
             patch.object(bridge.b,'run',side_effect=TimeoutError('unknown')) as send:
            result=bridge.send('t1','s','Correction',mode='steer')
            self.assertEqual(result['delivery'],'uncertain');self.assertEqual(send.call_count,1)

    def test_unsupported_claude_steer_does_not_type_anything(self):
        t=self.terminal('claude','working')
        with patch.object(bridge,'resolve',return_value=(t,'claude','s',Path('/tmp'),False)), \
             patch.object(bridge,'claude_send_now_supported',return_value=False),patch.object(bridge.b,'run') as send:
            with self.assertRaisesRegex(ValueError,'2.1.275'):bridge.send('t1','s','Correction',mode='steer')
            send.assert_not_called()

    def test_exit_ends_only_the_verified_terminal_including_remote_addresses(self):
        t=self.terminal()
        for address in ('t1','xps/t1'):
            with patch.object(bridge,'terminal',return_value=(t,'codex',42)), \
                 patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0)) as kill:
                self.assertEqual(bridge.exit_agent(address,bridge.process_key(t,'codex')),{'ok':True})
                kill.assert_called_once_with(['hc','kill',address])
        with patch.object(bridge,'terminal',return_value=(self.terminal(pid=43),'codex',43)),patch.object(bridge.b,'run') as kill:
            with self.assertRaises(ValueError):bridge.exit_agent('t1',bridge.process_key(t,'codex'))
            kill.assert_not_called()


class CapabilityTests(unittest.TestCase):
    def test_send_now_is_version_gated_and_remote_check_uses_the_machine(self):
        t=dict(foreground=dict(argv=['claude']))
        for version,supported in [('2.1.274',False),('2.1.275',True),('2.1.325',True),('invalid',False)]:
            with patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0,stdout=version)) as run:
                self.assertEqual(bridge.claude_send_now_supported('xps/t1',t),supported)
                run.assert_called_once_with(['hc','exec','--on','xps','--timeout','5','claude','--version'])
