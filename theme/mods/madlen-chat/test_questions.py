import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import bridge


class QuestionTests(unittest.TestCase):
    questions=[dict(id='color',question='Renk?',options=[dict(label='Açık'),dict(label='Koyu')])]

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
