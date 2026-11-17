"""Private, bounded snapshots. A cached transcript is never delivery evidence."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import images

VERSION = 1
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_FILES = 64


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def identity(terminal, kind):
    fg = terminal.get('foreground') or {}
    return dict(created=terminal.get('created_ms'), terminal_pid=terminal.get('pid'),
                process_pid=fg.get('pid'), argv=fg.get('argv'), kind=kind)


def location(address, limit):
    return images.HOME / 'data/madlen-chat/history' / (digest([address, limit]) + '.json')


def load(address, limit, terminal, kind):
    path = location(address, limit)
    try:
        if path.stat().st_size > MAX_FILE or time.time() - path.stat().st_mtime > 30 * 86400:
            return None
        entry = json.loads(path.read_text())
        if (entry['version'] != VERSION or entry['identity'] != identity(terminal, kind)
                or entry['address'] != address or entry['limit'] != limit):
            return None
        data = entry['data']
        if (data['terminal'] != address or not isinstance(data['session'], str) or not data['session']
                or not isinstance(data['messages'], list)
                or not all(isinstance(m, dict) and isinstance(m.get('id'), str)
                           and isinstance(m.get('role'), str) for m in data['messages'])):
            return None
        return data
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save(address, limit, terminal, kind, data):
    """Atomic best-effort cache; disk errors must not break the actual conversation."""
    temporary = None
    try:
        path = location(address, limit)
        entry = dict(version=VERSION, address=address, limit=limit,
                     identity=identity(terminal, kind), data=data)
        raw = encode(entry)
        if len(raw.encode()) > MAX_FILE:
            return
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.exists() and path.read_text() == raw:
            if time.time() - path.stat().st_mtime > 3600:
                path.touch()
            return
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(raw)
        os.replace(temporary, path)
        prune(path.parent)
    except (OSError, ValueError):
        pass
    finally:
        if temporary is not None:
            try: temporary.unlink(missing_ok=True)
            except OSError: pass


def prune(folder):
    size = 0
    paths = sorted(folder.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    for index, path in enumerate(paths):
        size += path.stat().st_size
        if index >= MAX_FILES or size > MAX_TOTAL or time.time() - path.stat().st_mtime > 30 * 86400:
            path.unlink(missing_ok=True)


def known(data):
    if not data: return None
    messages = data['messages']
    if len({m['id'] for m in messages}) != len(messages): return None
    return dict(session=data['session'], base=digest([data['session'], messages]),
                hashes={m['id']: digest(m) for m in messages})


def delta(data, previous):
    """Send only changed records; turn completion can update earlier records too."""
    if not previous or data['session'] != previous.get('session'): return data
    messages = data['messages']
    if len({m['id'] for m in messages}) != len(messages): return data
    result = {k: v for k, v in data.items() if k != 'messages'}
    result['delta'] = dict(base=previous['base'], order=[m['id'] for m in messages],
                           changed=[m for m in messages if previous['hashes'].get(m['id']) != digest(m)])
    return result


def merge(data, previous):
    if 'delta' not in data: return data
    patch = data['delta']
    evidence = known(previous)
    if not evidence or data['session'] != previous['session'] or patch['base'] != evidence['base']:
        raise ValueError('Sohbet önbelleği değişti; yeniden okunacak.')
    messages = {m['id']: m for m in previous['messages']}
    messages.update((m['id'], m) for m in patch['changed'])
    result = {k: v for k, v in data.items() if k != 'delta'}
    result['messages'] = [messages[key] for key in patch['order']]
    return result
