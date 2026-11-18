from datetime import datetime,timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import activity


class ActivityTests(unittest.TestCase):
    def setUp(self):
        root=Path('/tmp')/('claude-'+str(os.getuid()));root.mkdir(exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(prefix='herdr-activity-',dir=root);self.addCleanup(self.tmp.cleanup)
        self.sid='11111111-2222-3333-4444-555555555555'
        self.root=Path(self.tmp.name);self.tasks=self.root/self.sid/'tasks';self.tasks.mkdir(parents=True)
        self.output=self.tasks/'job.output';self.output.write_text('Preparing\nReady\n')
        self.log=self.root/'session.jsonl';self.now=1795000000

    def at(self,seconds):return datetime.fromtimestamp(seconds,timezone.utc).isoformat()

    def rows(self,task='job',age=600):
        at=self.at(self.now-age)
        return [dict(type='assistant',timestamp=at,message=dict(role='assistant',content=[dict(type='tool_use',id='call',name='Bash',
                    input=dict(command='fixture-check --wait',description='Yayını kontrol et',run_in_background=True))])),
                dict(type='user',timestamp=at,toolUseResult=dict(backgroundTaskId=task),message=dict(role='user',content=[
                    dict(type='tool_result',tool_use_id='call',content=f'Command running in background with ID: {task}. Output is being written to: {self.output}.')]))]

    def result(self,rows,writers=True):
        self.log.write_text(''.join(json.dumps(r)+'\n' for r in rows))
        evidence={str(self.output.resolve())} if writers is True else set() if writers is False else None
        with patch.object(activity,'writing_outputs',return_value=evidence):
            return activity.claude_jobs(self.log,self.sid,os.getpid(),now=self.now)

    def notification(self,status='completed',age=1,origin=True):
        return dict(type='user',timestamp=self.at(self.now-age),origin=dict(kind='task-notification' if origin else 'human'),
                    message=dict(role='user',content=f'<task-notification><task-id>job</task-id><status>{status}</status><summary>Fixture result</summary></task-notification>'))

    def test_live_shell_survives_finished_answer_and_long_history(self):
        rows=self.rows()+[dict(type='assistant',message=dict(role='assistant',content='Yanıt bitti.'))]*100
        job=self.result(rows)['jobs'][0]
        self.assertEqual(job['status'],'running');self.assertEqual(job['elapsed_seconds'],600)
        self.assertEqual(job['title'],'Yayını kontrol et');self.assertEqual(job['command'],'fixture-check --wait')
        self.assertEqual(job['output'],'Preparing\nReady')

    def test_native_completion_failure_and_stop_override_old_running_evidence(self):
        for native,expected in [('completed','completed'),('failed','failed'),('killed','stopped')]:
            job=self.result(self.rows()+[self.notification(native)])['jobs'][0]
            self.assertEqual(job['status'],expected);self.assertEqual(job['elapsed_seconds'],599)

    def test_user_xml_does_not_forge_completion(self):
        self.assertEqual(self.result(self.rows()+[self.notification(origin=False)])['jobs'][0]['status'],'running')

    def test_missing_writer_or_failed_verification_is_not_success(self):
        for writers in (False,None):
            data=self.result(self.rows(),writers)
            self.assertEqual(data['jobs'][0]['status'],'unknown')
            self.assertEqual(data['unavailable'],writers is None)

    def test_old_completed_tasks_disappear(self):
        self.assertEqual(self.result(self.rows()+[self.notification(age=301)])['jobs'],[])

    def test_sidechains_do_not_leak_into_the_selected_session(self):
        self.assertEqual(self.result([dict(r,isSidechain=True) for r in self.rows()])['jobs'],[])

    def test_output_path_rejects_other_sessions_arbitrary_files_and_symlinks(self):
        self.assertEqual(activity.output_path(str(self.output),self.sid,'job'),str(self.output.resolve()))
        for path,sid,task in [(str(self.output),'other','job'),('/etc/passwd',self.sid,'job'),(str(self.output),self.sid,'../job')]:
            self.assertIsNone(activity.output_path(path,sid,task))
        link=self.tasks/'link.output';link.symlink_to(self.output)
        self.assertIsNone(activity.output_path(str(link),self.sid,'link'))

    def test_tail_is_bounded_and_ansi_is_removed(self):
        self.output.write_text('old\n'*5000+'\x1b[32mFINAL\x1b[0m\n')
        text,_=activity.output_tail(str(self.output))
        self.assertLessEqual(len(text),1800);self.assertTrue(text.endswith('FINAL'));self.assertNotIn('\x1b',text)

    def test_os_evidence_requires_a_writing_descendant(self):
        with self.output.open('wb') as out:
            child=subprocess.Popen([sys.executable,'-c','import sys;sys.stdin.read()'],stdin=subprocess.PIPE,stdout=out,stderr=out)
        try:
            self.assertIn(str(self.output.resolve()),activity.writing_outputs(os.getpid(),{str(self.output.resolve())}))
        finally:
            child.communicate(timeout=3)
        with self.output.open('rb'):
            self.assertNotIn(str(self.output.resolve()),activity.writing_outputs(os.getpid(),{str(self.output.resolve())}))

    def test_codex_native_activity_is_separate_from_pagination_and_other_sessions(self):
        (self.root/'.codex').mkdir()
        with sqlite3.connect(self.root/'.codex/thread_history_1.sqlite') as db:
            db.execute('CREATE TABLE thread_items(thread_id,item_type,item_json,created_at_ms,rollout_ordinal)')
            for i,(sid,status) in enumerate([('s','inProgress'),('s','completed'),('other','inProgress')]):
                db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?)',(sid,'commandExecution',json.dumps(dict(id=str(i),status=status,
                           command='fixture-check',aggregatedOutput='Still running')),1000,i))
        with patch.object(activity.Path,'home',return_value=self.root):jobs=activity.codex_jobs('s')['jobs']
        self.assertEqual(len(jobs),1);self.assertEqual(jobs[0]['id'],'0');self.assertEqual(jobs[0]['status'],'running')


if __name__=='__main__':unittest.main()
