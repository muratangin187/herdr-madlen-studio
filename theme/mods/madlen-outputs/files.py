"""Bounded output discovery and previews for one verified local or remote agent."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'madlen-chat'))
import binding

MAX_TEXT = 400_000
MAX_FILE = 20 * 1024 * 1024
MAX_ITEMS = 500
TYPES = {
    'image': {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.heic', '.avif'},
    'markdown': {'.md', '.markdown'},
    'json': {'.json', '.jsonl', '.jsonc'},
    'html': {'.html', '.htm'},
    'pdf': {'.pdf'},
    'document': {'.doc', '.docx', '.odt', '.rtf', '.pages'},
    'spreadsheet': {'.csv', '.tsv', '.xls', '.xlsx', '.ods', '.numbers'},
    'presentation': {'.ppt', '.pptx', '.odp', '.key'},
    'archive': {'.zip', '.tar', '.gz', '.7z', '.rar'},
    'audio': {'.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'},
    'video': {'.mp4', '.mov', '.webm', '.mkv', '.avi'},
    'text': {'.txt', '.log', '.py', '.js', '.ts', '.tsx', '.jsx', '.css', '.yaml', '.yml', '.xml', '.sql', '.sh'},
}


def kind(path):
    if path.is_dir():
        return 'folder'
    return next((key for key, exts in TYPES.items() if path.suffix.lower() in exts), 'other')


def resolve(raw, cwd):
    raw = raw.strip().strip('`\"\'<>')
    if raw.startswith('file://'):
        uri = urlparse(raw)
        if uri.netloc not in ('', 'localhost'):
            return None
        raw = unquote(uri.path)
    elif re.match(r'^[a-zA-Z][\w+.-]*://', raw):
        return None
    raw = re.sub(r':\d+(?::\d+)?$|#L\d+(?:-L\d+)?$', '', raw)
    path = Path(os.path.expanduser(raw))
    if not path.is_absolute():
        if not cwd:
            return None
        path = Path(cwd) / path
    for candidate in (path, Path(str(path).rstrip('.,;:!?)]}'))):
        try:
            if candidate.exists():
                return candidate.resolve()
        except (OSError, ValueError):
            pass
    return None


def references(text, cwd):
    patterns = [r'\]\(\s*(<[^>\n]+>|[^\n]+?)\s*\)', r'`([^`\n]+)`',
                r'"((?:file://|/|~/)[^"\n]+)"', r"'((?:file://|/|~/)[^'\n]+)'",
                r'(?:file://(?:localhost)?/|(?<![\w:/])/(?!/)|~/)[^\s`\"<>]+']
    seen = set()
    for raw in [line.strip() for line in text.splitlines() if line.strip().startswith(('/', '~/', 'file://'))] + [
            m.group(1) if m.lastindex else m.group() for pattern in patterns for m in re.finditer(pattern, text)]:
        path = resolve(raw, cwd)
        if path and path not in seen:
            seen.add(path)
            yield path


def collect(history):
    items, seen = [], set()
    for message in history['messages']:
        for path in references(message['text'], message.get('cwd')):
            if path in seen or str(path) in ('/', '/Users', '/home'):
                continue
            seen.add(path)
            try:
                if not path.is_dir() and not path.is_file():
                    continue
                if not path.suffix and os.access(path, os.X_OK) and path.is_file():
                    continue
                stat = path.stat()
                file_kind = kind(path)
                items.append(dict(path=str(path), name=path.name, kind=file_kind,
                                  size=stat.st_size, mtime=stat.st_mtime,
                                  previewable=file_kind in ('image', 'markdown', 'json', 'text'),
                                  ext=path.suffix.lower().lstrip('.')))
            except OSError:
                continue
            if len(items) >= MAX_ITEMS:
                break
        if len(items) >= MAX_ITEMS:
            break
    items.sort(key=lambda f: (-f['mtime'], f['name'].casefold(), f['path']))
    return dict(items=items, session=history['session'], message_count=history.get('message_count', 0))


def execute(request):
    message = request.get('message')
    history = (binding.read_history(request['terminal'], message_id=message) if message is not None
               else binding.read_history(request['terminal']))
    result = collect(history)
    action = request.get('action', 'scan')
    if action == 'scan':
        return result
    if request.get('session') != result['session']:
        raise ValueError('Agentın oturumu değişti. Listeyi yenileyip tekrar deneyin.')
    requested = request.get('path')
    if message is not None:
        # A clicked chat link may be relative, a file URI, or carry a line number.
        # Resolve it only in the exact message, including messages older than the panel window.
        paths = {str(path) for m in history['messages']
                 if (path := resolve(requested or '', m.get('cwd'))) is not None}
    else:
        paths = {requested}
    item = next((f for f in result['items'] if f['path'] in paths), None)
    if not item:
        raise ValueError('Dosya artık bu oturumun çıktıları arasında değil. Listeyi yenileyin.')
    path = Path(item['path'])
    if action == 'open' and not request.get('remote'):
        args = ['/usr/bin/open'] + (['-R'] if item['kind'] == 'archive' else []) + [str(path)]
        subprocess.run(args, check=True, capture_output=True, timeout=10)
        return dict(ok=True)
    if item['kind'] == 'folder':
        raise ValueError('Uzak klasörler dış uygulamada açılamıyor; dosyaları tek tek açabilirsiniz.')
    if item['size'] > MAX_FILE:
        raise ValueError('Bu dosya 20 MB sınırını aşıyor. Dosyayı bulunduğu makinede açın.')
    # Limit the read itself too: files can grow after discovery.
    with path.open('rb') as file:
        data = file.read((MAX_TEXT if action == 'preview' and item['kind'] != 'image' else MAX_FILE) + 1)
    if action in ('open', 'download') or item['kind'] == 'image':
        if len(data) > MAX_FILE:
            raise ValueError('Dosya 20 MB sınırını aşıyor.')
        return dict(item=item, blob=base64.b64encode(data).decode())
    if not item['previewable']:
        raise ValueError('Bu dosya türünü dış uygulamada açabilirsiniz.')
    if b'\0' in data:
        raise ValueError('Bu dosyanın metin önizlemesi yok; dış uygulamada açabilirsiniz.')
    text = data[:MAX_TEXT].decode('utf-8-sig', errors='replace')
    return dict(item=item, text=text, truncated=len(data) > MAX_TEXT)


WORKER = r'''
import json,pathlib,sys,tempfile,types
request=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='madlen-outputs-') as directory:
    root=pathlib.Path(directory)
    for name,source in request.pop('sources').items():(root/name).write_text(source)
    sys.path.insert(0,str(root))
    import files,binding
    original=binding.run
    def run(args):
        if args[:2]==['hc','get']:return types.SimpleNamespace(returncode=0,stdout=json.dumps(request['metadata']))
        if args[:2]==['hc','read']:return types.SimpleNamespace(returncode=0,stdout=json.dumps({'text':request['screen']}))
        return original(args)
    binding.run=run
    try:print(json.dumps(files.execute(request),ensure_ascii=False))
    except Exception as error:print(json.dumps({'error':str(error)}))
'''


def dispatch(request):
    address = request['terminal']
    if not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)?', address):
        raise ValueError('Geçersiz agent adresi.')
    if '/' not in address:
        return execute(request)
    machine, local = address.split('/')
    metadata = binding.run(['hc', 'get', address, '--json'])
    screen = binding.run(['hc', 'read', address, '--lines', '0', '--json'])
    if metadata.returncode or screen.returncode:
        raise ValueError('Uzak agent okunamadı. Makine bağlantısını kontrol edin.')
    request = dict(request, terminal=local, remote=True, metadata=json.loads(metadata.stdout),
                   screen=json.loads(screen.stdout).get('text', ''),
                   sources={'files.py': Path(__file__).read_text(), 'binding.py': Path(binding.__file__).read_text()})
    response = subprocess.run(['hc', 'exec', '--on', machine, '--timeout', '25', '--stdin', 'python3', '-c', WORKER],
                              input=json.dumps(request), capture_output=True, text=True, timeout=30)
    if response.returncode:
        raise ValueError('Uzak çıktı okunamadı. Makine bağlantısını ve Python kurulumunu kontrol edin.')
    result = json.loads(response.stdout)
    if result.get('error'):
        raise ValueError(result['error'])
    return result


def cache_blob(result, home, terminal, download_root=None):
    blob = result.pop('blob', None)
    if blob is None:
        return result
    data = base64.b64decode(blob, validate=True)
    if len(data) > MAX_FILE:
        raise ValueError('Dosya 20 MB sınırını aşıyor.')
    key = hashlib.sha256(terminal.encode() + b'\0' + result['item']['path'].encode() + b'\0' + data).hexdigest()[:24]
    if download_root is not None:
        machine = terminal.split('/')[0] if '/' in terminal else 'local'
        folder = download_root / 'Herdr Çıktılar' / machine / key
    else:
        folder = home / 'data/madlen-outputs' / key
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder / Path(result['item']['name']).name
    # Keep symlinks out of the private cache, including on repeated reads.
    if path.is_symlink() or folder.is_symlink():
        raise ValueError('Çıktı önbelleği güvenle açılamadı.')
    if download_root is not None:
        original, counter = path, 2
        while path.exists():
            if path.is_symlink():
                raise ValueError('İndirilen dosya güvenle açılamadı.')
            if path.is_file() and path.stat().st_size == len(data) and path.read_bytes() == data:
                break
            path = original.with_name(f'{original.stem} ({counter}){original.suffix}')
            counter += 1
    if not path.exists():
        with tempfile.NamedTemporaryFile(dir=folder, delete=False) as file:
            file.write(data)
            temp = Path(file.name)
        temp.replace(path)
    result['cached_path'] = str(path)
    if download_root is not None:
        result['downloaded_path'] = str(path)
    else:
        result['image'] = str(path.relative_to(home))
    if result['item']['kind'] == 'image' and download_root is None:
        width, height = 640, 480
        try:
            if path.suffix.lower() == '.svg':
                import xml.etree.ElementTree as ET
                attrs = ET.fromstring(data).attrib
                box = attrs.get('viewBox', '').replace(',', ' ').split()
                if len(box) == 4:
                    width, height = float(box[2]), float(box[3])
            else:
                output = subprocess.run(['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(path)],
                                        capture_output=True, text=True, timeout=5).stdout
                width = int(re.search(r'pixelWidth:\s*(\d+)', output).group(1))
                height = int(re.search(r'pixelHeight:\s*(\d+)', output).group(1))
        except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
            pass
        result.update(width=max(1, width), height=max(1, height))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--terminal', required=True)
    parser.add_argument('--action', choices=['scan', 'preview', 'open', 'download'], default='scan')
    parser.add_argument('--session')
    parser.add_argument('--path')
    parser.add_argument('--message', help='Exact assistant message containing a clicked chat link')
    args = vars(parser.parse_args())
    try:
        result = dispatch(args)
        if result.get('blob') is not None:
            result = cache_blob(result, Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app')), args['terminal'],
                                download_root=Path.home() / 'Downloads' if args['action'] == 'download' else None)
            if args['action'] == 'open':
                subprocess.run(['/usr/bin/open'] + (['-R'] if result['item']['kind'] == 'archive' else []) +
                               [result['cached_path']], check=True, capture_output=True, timeout=10)
                result = dict(ok=True)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps(dict(error=str(error)), ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
