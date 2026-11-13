import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import bridge

class BridgeTests(unittest.TestCase):
    def test_question_card(self):
        v=bridge.codex_item({'type':'mcpToolCall','id':'q','tool':'request_user_input','arguments':{'questions':[{'question':'Renk?','options':[{'label':'Açık'}]}]}},1)
        self.assertEqual(v['role'],'question');self.assertEqual(v['questions'][0]['options'][0]['label'],'Açık')
    def test_reasoning_and_host_context_excluded(self):
        self.assertIsNone(bridge.codex_item({'type':'reasoning','text':'private'},1))
        self.assertIsNone(bridge.codex_item({'type':'userMessage','content':[{'type':'text','text':'# AGENTS.md instructions hidden'}]},1))
    def test_codex_user_text(self):
        v=bridge.codex_item({'type':'userMessage','content':[{'type':'text','text':'Merhaba'},{'type':'localImage','path':'/tmp/a.png'}]},1)
        self.assertEqual(v['text'],'Merhaba');self.assertEqual(len(v['attachments']),1)
    def test_claude_tools_and_result(self):
        rows=[{'uuid':'u','message':{'role':'user','content':'Merhaba'}},{'uuid':'a','message':{'role':'assistant','content':[{'type':'thinking','thinking':'private'},{'type':'text','text':'Bakıyorum'},{'type':'tool_use','id':'t','name':'Read','input':{'file_path':'test'}}]}},{'uuid':'r','message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'t','content':'result'}]}}]
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'test.jsonl';p.write_text('\n'.join(map(json.dumps,rows))+'\n{"partial":')
            m=bridge.records(p,'claude')
        self.assertEqual([x['role'] for x in m],['user','assistant','tool']);self.assertEqual(m[-1]['output'],'result');self.assertNotIn('private',str(m))
    def claude_records(self,rows):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'events.jsonl';p.write_text('\n'.join(map(json.dumps,rows)))
            return bridge.records(p,'claude')
    def test_background_notification_is_tool_not_user(self):
        body='<task-notification><task-id>fixture-task</task-id><status>completed</status><summary>Test command completed</summary></task-notification>'
        rows=[{'type':'api-request-blob','message':{'role':'user','content':'<system-reminder>'+body+'</system-reminder>'}},
              {'type':'user','uuid':'event','origin':{'kind':'task-notification'},'promptSource':'system','message':{'role':'user','content':body}}]
        messages=self.claude_records(rows)
        self.assertEqual(len(messages),1)
        self.assertEqual(messages[0]['role'],'tool');self.assertEqual(messages[0]['name'],'Arka plan görevi')
        self.assertEqual(messages[0]['text'],'Test command completed')
        self.assertEqual(messages[0]['status'],'completed')
    def test_user_xml_examples_are_preserved(self):
        for text in ['<task-notification><status>failed</status><summary>Example</summary></task-notification>',
                     '<system-reminder>This is my example</system-reminder>',
                     'Explain this: <task-notification>example</task-notification>']:
            message=self.claude_records([{'type':'user','uuid':'human','message':{'role':'user','content':text}}])[0]
            self.assertEqual(message['role'],'user');self.assertEqual(message['text'],text)
    def test_api_assistant_blob_is_not_a_duplicate_reply(self):
        payload={'role':'assistant','content':'Reply'}
        messages=self.claude_records([{'type':'api-request-blob','message':payload},{'type':'assistant','uuid':'real','message':payload}])
        self.assertEqual(len(messages),1);self.assertEqual(messages[0]['id'],'real')
    def test_failed_and_malformed_notifications_stay_non_user(self):
        for body in ['<task-notification><status>failed</status><summary>A &amp; B</summary></task-notification>','<task-notification>partial']:
            message=self.claude_records([{'type':'user','uuid':'event','turnOrigin':'task_notification','message':{'role':'user','content':body}}])[0]
            self.assertEqual(message['role'],'tool')
            self.assertNotIn('<task-notification>',message['text'])
            if 'failed' in body:self.assertEqual(message['status'],'failed');self.assertEqual(message['text'],'A & B')
    def test_meta_text_does_not_hide_tool_results(self):
        rows=[{'type':'assistant','uuid':'a','message':{'role':'assistant','content':[{'type':'tool_use','id':'tool1','name':'Read','input':{}}]}},
              {'type':'user','uuid':'r','isMeta':True,'message':{'role':'user','content':[{'type':'text','text':'System context'},{'type':'tool_result','tool_use_id':'tool1','content':'Result'}]}}]
        messages=self.claude_records(rows)
        self.assertEqual([m['role'] for m in messages],['tool','tool'])
        self.assertEqual(messages[0]['output'],'Result')
    def test_send_refuses_changed_session_or_busy(self):
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'idle'}},'codex','new',Path('/tmp'),True)),patch.object(bridge.b,'run') as run:
            with self.assertRaisesRegex(ValueError,'Oturum değişti'):bridge.send('t1','old','hello')
            run.assert_not_called()
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'blocked'}},'codex','s',Path('/tmp'),True)),patch.object(bridge.b,'run') as run:
            with self.assertRaisesRegex(ValueError,'Agent çalışıyor'):bridge.send('t1','s','yes')
            run.assert_not_called()
    def test_send_exact_target_no_shell(self):
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'idle'}},'claude','s',Path('/tmp'),False)),patch.object(bridge.b,'run') as run:
            run.return_value.returncode=0;run.return_value.stdout='{"started":true}'
            bridge.send('t1','s','hello $(no-shell)')
            run.assert_called_once_with(['hc','send','--if','idle','t1','hello $(no-shell)'])
    def test_done_send_and_delayed_working_signal_are_accepted(self):
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'done'}},'codex','s',Path('/tmp'),True)),patch.object(bridge.b,'run') as run:
            run.return_value.returncode=0;run.return_value.stdout='{"started":false,"turn":4}'
            self.assertEqual(bridge.send('t1','s','hello'),{'ok':True})
            run.assert_called_once_with(['hc','send','t1','hello'])
    def test_history_is_not_cut_to_last_180_records(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'test.jsonl'
            p.write_text(''.join(json.dumps({'uuid':str(i),'message':{'role':'assistant','content':[{'type':'text','text':str(i)}]}})+'\n' for i in range(700)))
            messages=bridge.records(p,'claude')
        self.assertEqual(len(messages),700)
        self.assertEqual(messages[0]['text'],'0');self.assertEqual(messages[-1]['text'],'699')
    def test_compact_summary_is_a_notice_not_a_user_message(self):
        rows=[{'type':'system','subtype':'compact_boundary','uuid':'b','content':'Conversation compacted'},
              {'type':'user','uuid':'s','isCompactSummary':True,'isVisibleInTranscriptOnly':True,'message':{'role':'user','content':'This session is being continued from a previous conversation...'}},
              {'type':'user','uuid':'u','message':{'role':'user','content':'Devam et'}}]
        messages=self.claude_records(rows)
        self.assertEqual([m['role'] for m in messages],['notice','user'])
        self.assertNotIn('continued',messages[0]['text'])
    def test_slash_command_and_local_output(self):
        rows=[{'type':'user','uuid':'c','message':{'role':'user','content':'<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>'}},
              {'type':'user','uuid':'o','message':{'role':'user','content':'<local-command-stdout>\x1b[2mSet model to Opus\x1b[22m</local-command-stdout>'}},
              {'type':'user','uuid':'e','message':{'role':'user','content':'<local-command-stdout></local-command-stdout>'}},
              {'type':'user','uuid':'x','message':{'role':'user','content':'Şunu açıkla: <command-name>/model</command-name>'}}]
        messages=self.claude_records(rows)
        self.assertEqual([(m['role'],m['text']) for m in messages],[('user','/model opus'),('notice','Set model to Opus'),('user','Şunu açıkla: <command-name>/model</command-name>')])
    def test_shell_command_and_output(self):
        rows=[{'type':'user','uuid':'i','message':{'role':'user','content':'<bash-input> gh repo fork x/y --clone=false</bash-input>'}},
              {'type':'user','uuid':'o','turnOrigin':'human','message':{'role':'user','content':'<bash-stdout>https://github.com/a/y\x1b[0m</bash-stdout><bash-stderr>warning</bash-stderr>'}},
              {'type':'user','uuid':'e','turnOrigin':'human','message':{'role':'user','content':'<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>'}}]
        messages=self.claude_records(rows)
        self.assertEqual((messages[0]['role'],messages[0]['text'],messages[0]['shell']),('user','gh repo fork x/y --clone=false',True))
        self.assertEqual([(m['role'],m['text'],m['error']) for m in messages[1:]],[('shell','https://github.com/a/y','warning'),('shell','','')])
    def test_mid_turn_and_queued_messages(self):
        rows=[{'type':'queue-operation','operation':'enqueue','content':'okundu mu'},
              {'type':'attachment','uuid':'q','attachment':{'type':'queued_command','prompt':'okundu mu','commandMode':'prompt','origin':{'kind':'human'}}},
              {'type':'queue-operation','operation':'remove','reason':'absorbed_mid_turn','content':'okundu mu'},
              {'type':'attachment','uuid':'n','attachment':{'type':'queued_command','prompt':'<task-notification>x</task-notification>','commandMode':'task-notification','origin':{'kind':'task-notification'}}},
              {'type':'queue-operation','operation':'enqueue','content':'sonraki prompt'},
              {'type':'queue-operation','operation':'dequeue'},
              {'type':'user','uuid':'p','message':{'role':'user','content':'sonraki prompt'}},
              {'type':'queue-operation','operation':'enqueue','content':'<task-notification>y</task-notification>'},
              {'type':'queue-operation','operation':'enqueue','content':'bekleyen'}]
        messages=self.claude_records(rows)
        self.assertEqual([(m['text'],bool(m.get('midturn')),bool(m.get('queued'))) for m in messages],
                         [('okundu mu',True,False),('sonraki prompt',False,False),('bekleyen',False,True)])
    def test_working_claude_send_joins_queue(self):
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'working'}},'claude','s',Path('/tmp'),False)),patch.object(bridge.b,'run') as run:
            run.return_value.returncode=0;run.return_value.stdout='{"started":false}'
            self.assertEqual(bridge.send('t1','s','bir de şuna bak'),{'ok':True})
            run.assert_called_once_with(['hc','send','--if','working','t1','bir de şuna bak'])
            run.reset_mock()
            for text in ('! ls','/compact'):
                with self.assertRaises(ValueError):bridge.send('t1','s',text)
            run.assert_not_called()
        with patch.object(bridge,'resolve',return_value=({'status':{'state':'working'}},'codex','s',Path('/tmp'),True)),patch.object(bridge.b,'run') as run:
            with self.assertRaisesRegex(ValueError,'Agent çalışıyor'):bridge.send('t1','s','hello')
            run.assert_not_called()
    SCREEN='\n'.join(['❯ Bash ile şu komutu çalıştır','  ⎿  $ touch a.txt','─'*60,' Bash command',' Tip: auto mode handles these prompts for you',' Create empty file a.txt',' '+'╌'*60,' touch a.txt',' '+'╌'*60,
                       ' Do you want to proceed?',' ❯ 1. Yes','   2. Yes, and always allow access to /tmp/x','      from this project','   3. No',' Esc to cancel · Tab to amend'])
    def test_permission_dialog_is_parsed(self):
        p=bridge.parse_prompt(self.SCREEN)
        self.assertEqual((p['title'],p['lines'],p['code'],p['question']),('Bash command',['Create empty file a.txt'],['touch a.txt'],'Do you want to proceed?'))
        self.assertEqual(p['options'],[{'key':'1','label':'Yes'},{'key':'2','label':'Yes, and always allow access to /tmp/x from this project'},{'key':'3','label':'No'}])
        self.assertIsNone(bridge.parse_prompt('just output\n'+'─'*60+'\n❯ '))
    def test_answer_presses_key_only_for_the_same_dialog(self):
        t={'status':{'state':'blocked','kind':'permission'},'foreground':{'name':'claude','pid':1}}
        fp=bridge.parse_prompt(self.SCREEN)['fingerprint']
        def run(args):
            r=type('R',(),{})();r.returncode=0;r.stdout=json.dumps({'text':self.SCREEN}) if args[:2]==['hc','read'] else '{}';run.calls.append(args);return r
        run.calls=[]
        with patch.object(bridge,'terminal',return_value=(t,'claude',1)),patch.object(bridge.b,'run',side_effect=run):
            with self.assertRaisesRegex(ValueError,'değişti'):bridge.answer('t1','stale',"1")
            with self.assertRaisesRegex(ValueError,'artık yok'):bridge.answer('t1',fp,"9")
            self.assertEqual(bridge.answer('t1',fp,"1"),{'ok':True})
        self.assertEqual([c for c in run.calls if c[:2]==['hc','keys']],[['hc','keys','t1','1']])
    def test_limit_reads_only_the_newest_messages(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'test.jsonl'
            rows=[]
            for i in range(300):
                rows.append({'uuid':f'a{i}','message':{'role':'assistant','content':[{'type':'text','text':str(i)},{'type':'tool_use','id':f't{i}','name':'Read','input':{}}]}})
                rows.append({'uuid':f'r{i}','message':{'role':'user','content':[{'type':'tool_result','tool_use_id':f't{i}','content':f'out{i}'}]}})
            p.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            messages,more=bridge.read_records(p,'claude',3)
            everything,rest=bridge.read_records(p,'claude')
        self.assertTrue(more);self.assertFalse(rest);self.assertEqual(len(everything),600)
        self.assertEqual([m['text'] for m in messages if m['role']=='assistant'],['297','298','299'])
        self.assertEqual([m.get('output') for m in messages if m['role']=='tool'],['out297','out298','out299'])
    def test_short_reply_binding_needs_two_matches_and_unique_session(self):
        texts=['Araç kullanma. Sadece iki satırlı mesaj alındı. yaz.','iki satırlı mesaj alındı.']
        screen=' '.join(texts)
        self.assertEqual(bridge.b.bind_recent([('a',texts)],texts[-1],screen),'a')
        self.assertIsNone(bridge.b.bind_recent([('a',texts),('b',texts)],texts[-1],screen))
        self.assertIsNone(bridge.b.bind_recent([('a',[texts[-1]])],texts[-1],screen))
    def test_invalid_address_refused(self):
        with self.assertRaisesRegex(ValueError,'Geçersiz'):bridge.terminal('xps/t1/invalid')

if __name__=='__main__':unittest.main()
