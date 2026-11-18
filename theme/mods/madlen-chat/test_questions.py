import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import bridge
from types import SimpleNamespace


class QuestionTests(unittest.TestCase):
    questions=[dict(id='color',question='Renk?',options=[dict(label='Açık'),dict(label='Koyu')])]
    SCREEN='\n'.join(['Earlier tool output','─'*60,' ☐ Test yolu','','│ Testi hangi ortamda yapalım?',
        '│ Ayrı bir ortam da seçebilirsiniz.','','❯ 1. Test ortamı','     Var olan test verilerini kullan.',
        '  2. Ayrı ortam','     Yeni bir örnekle çalış.','     Sonucu ayrıca göster.',
        '  3. Type something.','─'*60,'  4. Chat about this','','Enter to select · ↑/↓ to navigate · Esc to cancel'])

    def test_live_question_frame_and_wrapped_descriptions(self):
        prompt=bridge.parse_question_prompt(self.SCREEN)
        self.assertEqual(prompt['kind'],'question')
        self.assertEqual(prompt['title'],'Test yolu')
        self.assertEqual(prompt['question'],'Testi hangi ortamda yapalım? Ayrı bir ortam da seçebilirsiniz.')
        self.assertEqual(len(prompt['options']),3,'the footer action is not an answer option')
        self.assertEqual(prompt['options'][1]['description'],'Yeni bir örnekle çalış. Sonucu ayrıca göster.')
        self.assertEqual(prompt['options'][2]['label'],'Kendi yanıtınızı yazın')
        self.assertIsNone(bridge.parse_question_prompt('An example: 1. A\n2. B'))

    def test_live_question_without_any_transcript_question_reaches_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'s.jsonl';path.write_text(json.dumps(dict(type='assistant',message=dict(role='assistant',content='Kontrol ediyorum.'))))
            terminal=dict(status=dict(state='blocked',kind='question'),foreground=dict(pid=123,argv=['claude']))
            with patch.object(bridge,'resolve',return_value=(terminal,'claude','s',path,False)), \
                 patch.object(bridge.b,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(dict(text=self.SCREEN)))), \
                 patch('history_cache.save'):
                result=bridge.snapshot('t1',40)
        self.assertFalse(any(m['role']=='question' for m in result['messages']))
        self.assertEqual(result['prompt']['kind'],'question')
        self.assertEqual(len(result['prompt']['options']),3)

    def test_unknown_prompt_and_read_failure_still_have_visible_fallback(self):
        for kind,prompt_kind in [('claude','question'),('claude','permission'),('codex','question')]:
            terminal=dict(status=dict(state='blocked',kind=prompt_kind,msg='Choose a test environment'))
            with patch.object(bridge.b,'run',side_effect=OSError('unavailable')):
                prompt=bridge.blocked_prompt('t1',terminal,kind)
            self.assertEqual(prompt['kind'],'blocked')
            self.assertEqual(prompt['summary'],'Choose a test environment')
        self.assertIsNone(bridge.blocked_prompt('t1',dict(status=dict(state='idle')),'claude'))

    def test_live_question_never_uses_the_permission_key_action(self):
        terminal=dict(status=dict(state='blocked',kind='question'),foreground=dict(pid=123))
        fingerprint=bridge.parse_question_prompt(self.SCREEN)['fingerprint']
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run') as run:
            with self.assertRaisesRegex(ValueError,'İzin isteği değişti'):bridge.answer('t1',fingerprint,'1')
            run.assert_not_called()

    def answer_fixture(self,selected='1',change_after_move=False,move=True,enter_ok=True,address='t1'):
        terminal=dict(created_ms=1,pid=10,status_ms=100,status=dict(state='blocked',kind='question'),foreground=dict(pid=123,argv=['claude']))
        state=dict(selected=selected,changed=False);calls=[]
        def screen():
            text=self.SCREEN.replace('❯ 1.','  1.')
            text=text.replace('  '+state['selected']+'.','❯ '+state['selected']+'.')
            return text.replace('Testi hangi ortamda yapalım?','Yeni bir soru?') if state['changed'] else text
        fingerprint=bridge.parse_question_prompt(screen())['fingerprint']
        def run(args):
            calls.append(args)
            if args[:2]==['hc','read']:return SimpleNamespace(returncode=0,stdout=json.dumps(dict(text=screen())))
            self.assertEqual(args[:3],['hc','keys',address])
            if args[3:]!=['enter']:
                if move:state['selected']=str(int(state['selected'])+sum(1 if key=='down' else -1 for key in args[3:]))
                if change_after_move:state['changed']=True
            return SimpleNamespace(returncode=0 if enter_ok or args[3:]!=['enter'] else 1,stdout='')
        return terminal,fingerprint,run,calls

    def test_click_selects_and_verifies_target_before_enter(self):
        for address in ('t1','box/t1'):
            terminal,fingerprint,run,calls=self.answer_fixture(address=address)
            with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
                result=bridge.answer_question(address,bridge.process_key(terminal,'claude'),fingerprint,'2','100')
            self.assertTrue(result['ok'])
            keys=[call for call in calls if call[:2]==['hc','keys']]
            self.assertEqual(keys,[['hc','keys',address,'down'],['hc','keys',address,'enter']])
            self.assertEqual(calls[-2][:2],['hc','read'],'fresh screen verification immediately precedes Enter')

    def test_click_current_selection_only_submits_once(self):
        terminal,fingerprint,run,calls=self.answer_fixture()
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
            bridge.answer_question('t1',bridge.process_key(terminal,'claude'),fingerprint,'1')
        self.assertEqual([call for call in calls if call[:2]==['hc','keys']],[['hc','keys','t1','enter']])

    def test_changed_question_after_navigation_never_gets_enter(self):
        terminal,fingerprint,run,calls=self.answer_fixture(change_after_move=True)
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
            with self.assertRaisesRegex(ValueError,'Soru değişti'):bridge.answer_question('t1',bridge.process_key(terminal,'claude'),fingerprint,'2')
        self.assertNotIn(['hc','keys','t1','enter'],calls)

    def test_unconfirmed_selection_never_gets_enter(self):
        terminal,fingerprint,run,calls=self.answer_fixture(move=False)
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run),patch.object(bridge.time,'sleep'):
            with self.assertRaisesRegex(ValueError,'Seçenek doğrulanamadı'):bridge.answer_question('t1',bridge.process_key(terminal,'claude'),fingerprint,'2')
        self.assertNotIn(['hc','keys','t1','enter'],calls)

    def test_old_process_and_question_generation_never_submit(self):
        terminal,fingerprint,run,calls=self.answer_fixture()
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
            for expected,generation in [('old-process','100'),(bridge.process_key(terminal,'claude'),'old-generation')]:
                with self.assertRaises(ValueError):bridge.answer_question('t1',expected,fingerprint,'2',generation)
        self.assertFalse(any(call[:2]==['hc','keys'] for call in calls))

    def test_free_text_choice_does_not_paste_or_send_keys(self):
        terminal,fingerprint,run,calls=self.answer_fixture()
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
            with self.assertRaisesRegex(ValueError,'Terminal görünümünü'):bridge.answer_question('t1',bridge.process_key(terminal,'claude'),fingerprint,'3')
        self.assertFalse(any(call[:2]==['hc','keys'] for call in calls))

    def test_enter_failure_is_uncertain_and_never_replayed(self):
        terminal,fingerprint,run,calls=self.answer_fixture(enter_ok=False)
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
            result=bridge.answer_question('t1',bridge.process_key(terminal,'claude'),fingerprint,'2')
        self.assertEqual(result['delivery'],'uncertain')
        self.assertEqual(calls.count(['hc','keys','t1','enter']),1)

    def text_fixture(self,draft=False,changed=False,send_ok=True,address='t1'):
        terminal=dict(created_ms=1,pid=10,status_ms=100,status=dict(state='blocked',kind='question'),foreground=dict(pid=123,argv=['claude']))
        state=dict(selected='1');calls=[]
        fingerprint=bridge.parse_question_prompt(self.SCREEN)['fingerprint']
        def run(args):
            calls.append(args)
            if args[:2]==['hc','read']:
                screen=self.SCREEN
                if state['selected']=='3':
                    screen=screen.replace('❯ 1.','  1.').replace('  3. Type something.','❯ 3. '+('Mevcut taslak' if draft else ''))
                    screen=screen.replace('Enter to select','Enter to submit')
                    if changed:screen=screen.replace('Testi hangi ortamda yapalım?','Başka bir soru?')
                return SimpleNamespace(returncode=0,stdout=json.dumps(dict(text=screen)))
            if args[:2]==['hc','keys']:
                self.assertEqual(args,['hc','keys',address,'down','down']);state['selected']='3'
            else:self.assertEqual(args[:5],['hc','send','--force','--',address])
            return SimpleNamespace(returncode=0 if send_ok else 1,stdout='')
        return terminal,fingerprint,run,calls

    def test_free_text_preserves_unicode_multiline_and_literal_prefixes(self):
        for address in ('t1','box/t1'):
            terminal,fingerprint,run,calls=self.text_fixture(address=address)
            text='-- Türkçe ğüşİ 🙂\n! / Bu bir yanıt; komut değil.'
            with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
                result=bridge.answer_question(address,bridge.process_key(terminal,'claude'),fingerprint,'3','100',text)
            self.assertTrue(result['ok'])
            self.assertEqual(calls[-1],['hc','send','--force','--',address,text])
            self.assertEqual(calls[-2][:2],['hc','read'])

    def test_empty_focused_text_row_keeps_the_same_question_identity(self):
        focused=self.SCREEN.replace('❯ 1.','  1.').replace('  3. Type something.','❯ 3.').replace('Enter to select','Enter to submit')
        original=bridge.parse_question_prompt(self.SCREEN);prompt=bridge.parse_question_prompt(focused)
        self.assertEqual(prompt['fingerprint'],original['fingerprint'])
        self.assertTrue(prompt['can_answer']);self.assertTrue(prompt['input_empty'])
        self.assertEqual(prompt['options'][-1]['kind'],'text')

    def test_free_text_never_overwrites_a_terminal_draft_or_new_question(self):
        for kwargs in (dict(draft=True),dict(changed=True)):
            terminal,fingerprint,run,calls=self.text_fixture(**kwargs)
            with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=run):
                with self.assertRaises(ValueError):bridge.answer_question('t1',bridge.process_key(terminal,'claude'),fingerprint,'3','100','Benim yanıtım')
            self.assertFalse(any(call[:2]==['hc','send'] for call in calls))

    def test_invalid_free_text_is_rejected_before_any_terminal_input(self):
        for text in ('','  ','a'*10001,'unsafe\x1b[201~','unsafe\x00'):
            with patch.object(bridge.b,'run') as run,patch.object(bridge,'terminal') as terminal:
                with self.assertRaises(ValueError):bridge.answer_question('t1','process','fp','3',text=text)
                run.assert_not_called();terminal.assert_not_called()

    def test_free_text_transport_failure_is_uncertain(self):
        terminal,fingerprint,run,calls=self.text_fixture()
        def fail_send(args):
            result=run(args)
            if args[:2]==['hc','send']:result.returncode=1
            return result
        with patch.object(bridge,'terminal',return_value=(terminal,'claude',123)),patch.object(bridge.b,'run',side_effect=fail_send):
            result=bridge.answer_question('t1',bridge.process_key(terminal,'claude'),fingerprint,'3','100','Yanıt')
        self.assertEqual(result['delivery'],'uncertain')
        self.assertEqual(sum(call[:2]==['hc','send'] for call in calls),1)

    def read(self,rows,kind='claude',limit=None):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'fixture.jsonl'
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            return bridge.read_records(path,kind,limit)[0]

    def claude_call(self):
        return dict(type='assistant',uuid='call',message=dict(role='assistant',content=[
            dict(type='tool_use',id='q',name='AskUserQuestion',input=dict(questions=self.questions))]))

    def claude_result(self,**kw):
        return dict(type='user',uuid='result',toolUseResult=dict(answers={'Renk?':'Koyu'}),
                    message=dict(role='user',content=[dict(type='tool_result',tool_use_id='q',content='Answer received',**kw)]))

    def test_claude_pending_then_answered_including_pagination(self):
        pending=self.read([self.claude_call()])[0]
        self.assertEqual((pending['question_state'],pending['status']),('pending','inProgress'))
        for limit in (None,1):
            answered=self.read([self.claude_call(),self.claude_result()],limit=limit)[0]
            self.assertEqual((answered['question_state'],answered['status']),('answered','completed'))
            self.assertEqual(answered['answers'],{'Renk?':'Koyu'})
            self.assertEqual(answered['output'],'Answer received')

    def test_cancelled_question_never_claims_answered(self):
        result=self.claude_result(is_error=True);result.pop('toolUseResult')
        question=self.read([self.claude_call(),result])[0]
        self.assertEqual(question['question_state'],'failed')
        self.assertNotIn('answers',question)

    def test_legacy_text_answer_is_preserved(self):
        result=self.claude_result();result.pop('toolUseResult')
        result['message']['content'][0]['content']='User has answered your questions: "Renk?"="Koyu".'
        question=self.read([self.claude_call(),result])[0]
        self.assertEqual(question['question_state'],'answered')
        self.assertIn('Koyu',question['answer_text'])

    def test_unrelated_result_does_not_answer_question(self):
        result=self.claude_result();result['message']['content'][0]['tool_use_id']='other'
        self.assertEqual(self.read([self.claude_call(),result])[0]['question_state'],'pending')

    def test_codex_projected_questions_are_visible_even_without_text(self):
        for text in ('Bir tercih yapın.',''):
            with tempfile.TemporaryDirectory() as folder:
                home=Path(folder);(home/'.codex').mkdir()
                item=dict(type='agentMessage',id='q',text=text,phase='final_answer',delivery='async',
                          questions=[dict(title='Renk?',options=['Açık','Koyu']),dict(title='Notunuz?',options=None)])
                with sqlite3.connect(home/'.codex/thread_history_1.sqlite') as db:
                    db.execute('CREATE TABLE thread_items(thread_id,rollout_ordinal,item_json,item_type)')
                    db.execute('INSERT INTO thread_items VALUES(?,?,?,?)',('s',1,json.dumps(item),'agentMessage'))
                with patch.object(bridge.Path,'home',return_value=home):messages,more=bridge.projected('s',40)
            self.assertEqual(len(messages),1)
            self.assertEqual(messages[0]['role'],'question')
            self.assertEqual(messages[0]['question_intro'],text)
            self.assertEqual(messages[0]['questions'][0]['options'],['Açık','Koyu'])
            self.assertEqual(messages[0]['question_state'],'pending')
            self.assertFalse(more)

    def codex_call(self,name='request_user_input'):
        return dict(type='response_item',payload=dict(type='function_call',call_id='q',name=name,
                    arguments=json.dumps(dict(questions=self.questions))))

    def codex_result(self,value):
        return dict(type='response_item',payload=dict(type='function_call_output',call_id='q',output=json.dumps(value)))

    def test_codex_result_with_answer_ids(self):
        question=self.read([self.codex_call(),self.codex_result(dict(answers={'color':{'answers':['Koyu']}}))],'codex')[0]
        self.assertEqual(question['question_state'],'answered')
        self.assertEqual(question['answers']['color']['answers'],['Koyu'])

    def test_projected_mcp_answers_and_errors(self):
        answers={'color':{'answers':['Koyu']}}
        for result in (dict(answers=answers),dict(structuredContent=dict(answers=answers)),
                       dict(content=[dict(type='text',text=json.dumps(dict(answers=answers)))])):
            item=bridge.codex_item(dict(type='mcpToolCall',id='q',tool='request_user_input',status='completed',
                                       arguments=dict(questions=self.questions),result=result),1)
            self.assertEqual(item['question_state'],'answered')
            self.assertEqual(item['answers'],answers)
        item=bridge.codex_item(dict(type='mcpToolCall',id='q',tool='request_user_input',status='failed',
                                   arguments=dict(questions=self.questions),error=dict(answers=answers)),1)
        self.assertEqual(item['question_state'],'failed')
        self.assertNotIn('answers',item)

    def test_async_receipt_is_not_an_answer_after_turn_completion(self):
        rows=[self.codex_call('request_user_input_async'),self.codex_result(dict(accepted=True)),
              dict(type='event_msg',payload=dict(type='task_complete',turn_id='turn'))]
        question=self.read(rows,'codex')[0]
        self.assertEqual(question['question_state'],'pending')
        self.assertNotIn('answers',question)

    def test_superseded_question_closes_without_inventing_answer(self):
        for kind,call in [('claude',self.claude_call()),('codex',self.codex_call('request_user_input_async'))]:
            user=dict(role='user',content='Başka bir iş yapalım.')
            record=dict(type='user',uuid='u',message=user) if kind=='claude' else dict(type='response_item',payload=dict(type='message',**user))
            question=self.read([call,record],kind)[0]
            self.assertEqual(question['question_state'],'closed')
            self.assertNotIn('answers',question)

    def test_malformed_question_lists_do_not_break_chat(self):
        for value in (None,'bad',{},[None,'bad']):
            self.assertEqual(bridge.question_list(dict(questions=value)),[])


if __name__=='__main__':unittest.main()
