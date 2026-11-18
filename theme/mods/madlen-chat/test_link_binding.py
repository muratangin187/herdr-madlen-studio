import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import binding


class LinkBindingTests(unittest.TestCase):
    def test_exact_projected_message_outside_last_50_and_other_session(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with sqlite3.connect(root/'thread_history_1.sqlite') as db:
                db.execute('CREATE TABLE thread_items(thread_id,rollout_ordinal,created_at_ms,item_type,item_json)')
                for i in range(70):
                    item=dict(id=f'a{i}',type='agentMessage',text=f'/tmp/report-{i}.html',cwd='/project')
                    db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?)',('s',i,i,'agentMessage',json.dumps(item)))
                db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?)',('other',0,0,'agentMessage',json.dumps(dict(id='a0',text='/private.txt'))))
                db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?)',('s',100,100,'agentMessage',json.dumps(dict(text='/tmp/ordinal.md'))))
            messages,count=binding.projected_messages(root,'s','/fallback',message_id='a0')
            self.assertEqual(count,1);self.assertEqual(messages[0]['text'],'/tmp/report-0.html')
            self.assertEqual(messages[0]['cwd'],'/project')
            self.assertEqual(binding.projected_messages(root,'s','/fallback',message_id='missing'),([],0))
            self.assertEqual(binding.projected_messages(root,'s','/fallback',message_id='0'),([],0))
            self.assertEqual(binding.projected_messages(root,'s','/fallback',message_id='100')[0][0]['text'],'/tmp/ordinal.md')

    def test_exact_claude_message_beyond_window_skips_sidechain_and_users(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'session.jsonl'
            rows=[dict(type='assistant',uuid='old',message=dict(role='assistant',content=[dict(type='text',text='/tmp/old.html')]))]
            rows += [dict(type='assistant',uuid=f'a{i}',message=dict(role='assistant',content='Newer reply')) for i in range(70)]
            rows += [dict(type='assistant',uuid='old',isSidechain=True,message=dict(role='assistant',content='/private.txt'))]
            rows += [dict(type='user',uuid='user',message=dict(role='user',content='/input.txt'))]
            path.write_text('\n'.join(map(json.dumps,rows)))
            messages,count=binding.log_messages(path,'claude',folder,message_id='old')
            self.assertEqual(count,1);self.assertEqual([m['text'] for m in messages],['text\n/tmp/old.html'])
            self.assertEqual(binding.log_messages(path,'claude',folder,message_id='user')[0],[])


if __name__=='__main__':unittest.main()
