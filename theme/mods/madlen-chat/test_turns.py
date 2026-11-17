import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import bridge


class TurnTests(unittest.TestCase):
    def read(self,rows,kind='codex',limit=None):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'fixture.jsonl'
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            return bridge.read_records(path,kind,limit)[0]

    def event(self,name,**kw):
        return dict(type='event_msg',timestamp='2026-01-01T00:00:00Z',payload=dict(type=name,turn_id='turn',**kw))

    def message(self,role,text,channel=None):
        return dict(type='response_item',timestamp='2026-01-01T00:00:01Z',payload=dict(type='message',role=role,
                    channel=channel,content=[dict(type='output_text' if role=='assistant' else 'input_text',text=text)]))

    def test_codex_completion_and_duration_come_from_lifecycle(self):
        rows=[self.event('task_started'),self.message('user','Do work'),self.message('assistant','Starting','commentary'),
              dict(type='response_item',payload=dict(type='function_call',name='test',call_id='tool',arguments='{}')),
              self.message('assistant','Finished','final'),self.event('task_complete',duration_ms=464000)]
        messages=self.read(rows)
        self.assertTrue(all(m['turn_id']=='turn' and m['turn_status']=='completed' for m in messages))
        self.assertTrue(all(m['duration_ms']==464000 for m in messages))
        self.assertEqual(messages[-1]['id'],messages[-1]['final_id'])
        self.assertEqual(messages[-1]['phase'],'final')
        # A page that starts mid-turn still receives the native completion metadata.
        partial=self.read(rows,limit=2)
        self.assertTrue(all(m['turn_status']=='completed' for m in partial))
        self.assertEqual(partial[-1]['duration_ms'],464000)

    def test_active_and_aborted_turns_are_never_completed(self):
        rows=[self.event('task_started'),self.message('assistant','In progress','commentary')]
        for ending in ([],[self.event('turn_aborted',duration_ms=9000)]):
            messages=self.read(rows+ending)
            self.assertNotEqual(messages[-1]['turn_status'],'completed')
            self.assertIsNone(messages[-1]['final_id'])

    def test_claude_duration_marker_and_end_turn(self):
        rows=[dict(type='user',uuid='u',timestamp='2026-01-01T00:00:00Z',message=dict(role='user',content='Do work')),
              dict(type='assistant',uuid='a',message=dict(role='assistant',stop_reason='tool_use',content=[
                  dict(type='text',text='Starting'),dict(type='tool_use',id='tool',name='Read',input={})])),
              dict(type='assistant',uuid='final',message=dict(role='assistant',stop_reason='end_turn',content=[dict(type='text',text='Finished')])),
              dict(type='system',subtype='turn_duration',durationMs=464000)]
        messages=self.read(rows,'claude')
        self.assertEqual(messages[-1]['turn_id'],'claude-final')
        self.assertTrue(all(m['duration_ms']==464000 for m in messages))
        self.assertEqual(messages[-1]['final_id'],'final')
        active=self.read(rows[:2],'claude')
        self.assertTrue(all(m['turn_status']!='completed' for m in active))
        without_duration=self.read(rows[:-1],'claude')
        self.assertIsNone(without_duration[-1]['duration_ms'],'do not invent a duration from partial timestamps')

    def test_queued_human_message_is_not_attached_to_finished_work(self):
        rows=[dict(type='assistant',uuid='final',message=dict(role='assistant',stop_reason='end_turn',content='Finished')),
              dict(type='queue-operation',operation='enqueue',content='Next request')]
        messages=self.read(rows,'claude')
        self.assertEqual(messages[-1]['role'],'user')
        self.assertTrue(messages[-1]['queued'])
        self.assertNotIn('turn_id',messages[-1])

    def test_projected_completion_and_final_id_use_the_same_turn(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);(home/'.codex').mkdir()
            with sqlite3.connect(home/'.codex/thread_history_1.sqlite') as db:
                db.executescript('''CREATE TABLE thread_turns(thread_id,turn_id,status,duration_ms,final_agent_item_id);
                    CREATE TABLE thread_items(thread_id,turn_id,rollout_ordinal,created_at_ms,item_json,item_type);''')
                db.executemany('INSERT INTO thread_turns VALUES(?,?,?,?,?)',[
                    ('s','done','completed',464000,'final'),('s','live','inProgress',None,None),('other','done','completed',1,'wrong')])
                for i,(turn,item) in enumerate([
                    ('done',dict(type='userMessage',id='u',content=[dict(type='text',text='Do work')])),
                    ('done',dict(type='agentMessage',id='progress',text='Starting',phase='commentary')),
                    ('done',dict(type='agentMessage',id='final',text='Finished',phase='final_answer')),
                    ('live',dict(type='agentMessage',id='live',text='Working',phase='commentary'))]):
                    db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?,?)',('s',turn,i,1000+i,json.dumps(item),item['type']))
            with patch.object(bridge.Path,'home',return_value=home):messages,more=bridge.projected('s',40)
        self.assertFalse(more)
        self.assertEqual(messages[1]['final_id'],'final')
        self.assertEqual(messages[1]['duration_ms'],464000)
        self.assertEqual(messages[-1]['turn_status'],'inProgress')
        self.assertIsNone(messages[-1]['final_id'])

    def test_legacy_projection_without_turn_table_stays_readable(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);(home/'.codex').mkdir()
            with sqlite3.connect(home/'.codex/thread_history_1.sqlite') as db:
                db.execute('CREATE TABLE thread_items(thread_id,rollout_ordinal,item_json,item_type)')
                db.execute('INSERT INTO thread_items VALUES(?,?,?,?)',('s',1,json.dumps(dict(type='agentMessage',id='a',text='Hello')),'agentMessage'))
            with patch.object(bridge.Path,'home',return_value=home):messages,_=bridge.projected('s')
        self.assertEqual(messages[0]['text'],'Hello')
        self.assertIsNone(messages[0]['turn_status'])
