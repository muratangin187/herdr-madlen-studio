import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_outputs', ROOT / 'theme/mods/madlen-outputs/files.py')
outputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(outputs)


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def file(self, name, text='', mtime=100):
        p = self.root / name
        p.write_text(text)
        os.utime(p, (mtime, mtime))
        return p

    def history(self, *paths, session='s'):
        return dict(session=session, messages=[dict(text=' '.join(f'[{p.name}](<{p}>)' for p in paths), cwd=str(self.root))])

    def test_reference_paths_spaces_unicode_links_and_missing_files(self):
        p = self.file('Türkçe rapor (son).md')
        for raw in (f'[Rapor](<{p}:12>)', f'`{p}#L4`', p.as_uri()):
            self.assertEqual(list(outputs.references(raw, self.root)), [p])
        self.assertEqual(list(outputs.references('https://example.test/report.pdf `missing.pdf`', self.root)), [])
        self.assertIsNone(outputs.resolve('file://another-host/private.txt', self.root))

    def test_newest_file_first_with_symlink_dedup(self):
        old = self.file('old.md', mtime=100)
        new = self.file('new.json', mtime=300)
        alias = self.root / 'alias.json'
        alias.symlink_to(new)
        result = outputs.collect(self.history(old, new, alias, self.root / 'gone.png'))
        self.assertEqual([f['name'] for f in result['items']], ['new.json', 'old.md'])
        self.assertEqual([f['kind'] for f in result['items']], ['json', 'markdown'])
        self.assertEqual(outputs.collect(self.history())['items'], [])

    def test_each_supported_category(self):
        for ext, kind in [('png','image'),('pdf','pdf'),('docx','document'),('xlsx','spreadsheet'),
                          ('pptx','presentation'),('html','html'),('zip','archive'),('wav','audio'),
                          ('mp4','video'),('txt','text'),('unknown','other')]:
            self.assertEqual(outputs.kind(self.file('test.' + ext)), kind)
        self.assertEqual(outputs.kind(self.root), 'folder')

    def test_wrong_session_and_unlisted_path_never_open(self):
        p = self.file('report.md', 'hello')
        request = dict(terminal='t1', action='open', session='wrong', path=str(p))
        with patch.object(outputs.binding, 'read_history', return_value=self.history(p)), patch.object(outputs.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'oturumu değişti'):
                outputs.execute(request)
            request.update(session='s', path=str(self.root / 'private.txt'))
            with self.assertRaisesRegex(ValueError, 'arasında değil'):
                outputs.execute(request)
            run.assert_not_called()

    def test_json_preview_preserves_number_precision(self):
        text = '{"id":900719925474099312345,"ratio":1.234567890123456789}'
        p = self.file('report.json', text)
        with patch.object(outputs.binding, 'read_history', return_value=self.history(p)):
            result = outputs.execute(dict(terminal='t1', action='preview', session='s', path=str(p)))
        self.assertEqual(result['text'], text)
        self.assertFalse(result['truncated'])

    def test_clicked_link_resolves_only_in_exact_message(self):
        p=self.file('Türkçe rapor.html','<html>Fixture</html>')
        for raw in (str(p)+':12',p.as_uri(),'Türkçe rapor.html'):
            with patch.object(outputs.binding,'read_history',return_value=self.history(p)) as read,patch.object(outputs.subprocess,'run') as run:
                outputs.execute(dict(terminal='t1',action='open',session='s',message='old-message',path=raw))
                read.assert_called_once_with('t1',message_id='old-message')
                self.assertEqual(run.call_args.args[0],['/usr/bin/open',str(p)])
        other=self.file('other.html')
        with patch.object(outputs.binding,'read_history',return_value=self.history(p)),patch.object(outputs.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'arasında değil'):
                outputs.execute(dict(terminal='t1',action='open',session='s',message='old-message',path=str(other)))
            run.assert_not_called()

    def test_text_preview_is_bounded_and_binary_is_not_decoded(self):
        p = self.file('large.txt', 'a' * (outputs.MAX_TEXT + 10))
        with patch.object(outputs.binding, 'read_history', return_value=self.history(p)):
            result = outputs.execute(dict(terminal='t1', action='preview', session='s', path=str(p)))
            self.assertEqual(len(result['text']), outputs.MAX_TEXT)
            self.assertTrue(result['truncated'])
            p.write_bytes(b'abc\0binary')
            with self.assertRaisesRegex(ValueError, 'metin önizlemesi yok'):
                outputs.execute(dict(terminal='t1', action='preview', session='s', path=str(p)))

    def test_external_open_uses_argument_array_and_archive_reveals(self):
        p = self.file('weird $(touch bad);.zip')
        with patch.object(outputs.binding, 'read_history', return_value=self.history(p)), patch.object(outputs.subprocess, 'run') as run:
            outputs.execute(dict(terminal='t1', action='open', session='s', path=str(p)))
            self.assertEqual(run.call_args.args[0], ['/usr/bin/open', '-R', str(p)])

    def test_remote_cache_separates_hosts_and_content_with_same_filename(self):
        def result(data):
            return dict(item=dict(name='same.md', path='/tmp/same.md', kind='markdown'), blob=base64.b64encode(data).decode())
        a = outputs.cache_blob(result(b'a'), self.root, 'xps/t1')
        b = outputs.cache_blob(result(b'a'), self.root, 'other/t1')
        c = outputs.cache_blob(result(b'b'), self.root, 'xps/t1')
        self.assertEqual(len({a['cached_path'], b['cached_path'], c['cached_path']}), 3)
        self.assertEqual(Path(c['cached_path']).read_bytes(), b'b')
        Path(a['cached_path']).unlink()
        Path(a['cached_path']).symlink_to(self.file('private.txt', 'private'))
        with self.assertRaisesRegex(ValueError, 'önbelleği'):
            outputs.cache_blob(result(b'a'), self.root, 'xps/t1')

    def test_invalid_remote_address_never_executes(self):
        with patch.object(outputs.binding, 'run') as run:
            for address in ('xps/t1/extra', 'xps;bad/t1', '/t1'):
                with self.assertRaisesRegex(ValueError, 'adres'):
                    outputs.dispatch(dict(terminal=address))
            run.assert_not_called()

    def test_download_saves_exact_bytes_in_downloads_without_opening(self):
        p = self.file('Türkçe rapor.html', '<html>Fixture</html>')
        with patch.object(outputs.binding, 'read_history', return_value=self.history(p)), patch.object(outputs.subprocess, 'run') as run:
            result = outputs.execute(dict(terminal='t1', action='download', session='s', path=str(p), remote=True))
            saved = outputs.cache_blob(result, self.root / 'app', 'xps/t1', download_root=self.root / 'Downloads')
            run.assert_not_called()
        path = Path(saved['downloaded_path'])
        self.assertTrue(path.is_relative_to(self.root / 'Downloads/Herdr Çıktılar/xps'))
        self.assertEqual(path.name, p.name)
        self.assertEqual(path.read_bytes(), p.read_bytes())
        self.assertNotIn('image', saved)
        path.write_text('User edits')
        result = dict(item=dict(name=p.name, path=str(p), kind='html'), blob=base64.b64encode(p.read_bytes()).decode())
        again = outputs.cache_blob(result, self.root / 'app', 'xps/t1', download_root=self.root / 'Downloads')
        self.assertNotEqual(again['downloaded_path'], str(path))
        self.assertEqual(path.read_text(), 'User edits')
        self.assertEqual(Path(again['downloaded_path']).read_bytes(), p.read_bytes())

    def test_remote_worker_reads_only_the_exact_process_without_remote_hc(self):
        sid = '11111111-2222-3333-4444-555555555555'
        (self.root / '.claude/sessions').mkdir(parents=True)
        (self.root / '.claude/projects/fixture').mkdir(parents=True)
        (self.root / f'.claude/sessions/{os.getpid()}.json').write_text(json.dumps(dict(sessionId=sid)))
        report = self.file('Remote report.md', 'fixture')
        (self.root / f'.claude/projects/fixture/{sid}.jsonl').write_text(json.dumps(dict(type='assistant',uuid='old-message',
            message=dict(role='assistant', content=[dict(type='text', text=f'[Report](<{report}>)')]))) + '\n')
        request = dict(terminal='t1', action='scan', remote=True, metadata=dict(foreground=dict(pid=os.getpid(), name='claude'),
                       status=dict(app='claude')), screen='', sources={
                       'files.py': Path(outputs.__file__).read_text(), 'binding.py': Path(outputs.binding.__file__).read_text()})
        response = subprocess.run([sys.executable, '-c', outputs.WORKER], input=json.dumps(request), capture_output=True,
                                  text=True, timeout=10, env={**os.environ, 'HOME': str(self.root)})
        self.assertEqual(response.returncode, 0, response.stderr)
        result = json.loads(response.stdout)
        self.assertNotIn('error', result, result)
        self.assertEqual(result['session'], sid)
        self.assertEqual([i['path'] for i in result['items']], [str(report)])
        request.update(action='download',session=sid,message='old-message',path=report.as_uri()+':12')
        response=subprocess.run([sys.executable,'-c',outputs.WORKER],input=json.dumps(request),capture_output=True,
                                text=True,timeout=10,env={**os.environ,'HOME':str(self.root)})
        self.assertEqual(response.returncode,0,response.stderr)
        result=json.loads(response.stdout)
        self.assertNotIn('error',result,result)
        self.assertEqual(base64.b64decode(result['blob']),b'fixture')


if __name__ == '__main__':
    unittest.main()
