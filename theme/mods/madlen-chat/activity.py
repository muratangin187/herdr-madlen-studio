"""Read-only background shell activity belonging to one verified conversation."""
from datetime import datetime
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import binding

MAX_RECORDS=8000
MAX_JOBS=24
RECENT_SECONDS=300
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def timestamp(value):
    try:return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except (AttributeError,TypeError,ValueError,OverflowError):return None


def content_text(value):
    if isinstance(value,str):return value
    return '\n'.join(c.get('text','') for c in value or [] if isinstance(c,dict) and c.get('type')=='text')


def tail_text(text):
    return '\n'.join(line[-240:] for line in ANSI.sub('',text).replace('\r','\n').splitlines() if line.strip())[-1800:]


def output_path(value,sid,task):
    """Only shell output files inside this session's private Claude temp tree."""
    if not isinstance(value,str) or not re.fullmatch(r'[\w-]{1,128}',task):return None
    path=Path(value)
    if not path.is_absolute() or path.name!=task+'.output' or path.parent.name!='tasks' or path.parent.parent.name!=sid:return None
    root=Path('/tmp')/('claude-'+str(os.getuid()))
    try:
        resolved=path.resolve(strict=True)
        resolved.relative_to(root.resolve())
        if path.is_symlink() or resolved.parent.name!='tasks' or resolved.parent.parent.name!=sid:return None
        if not stat.S_ISREG(resolved.stat().st_mode):return None
        return str(resolved)
    except (OSError,ValueError,RuntimeError):return None


def output_tail(path):
    if not path:return '',None
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|getattr(os,'O_NOFOLLOW',0))
        with os.fdopen(fd,'rb') as file:
            info=os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode):return '',None
            file.seek(max(0,info.st_size-8192))
            return tail_text(file.read(8192).decode('utf-8',errors='replace')),info.st_mtime
    except OSError:return '',None


def process_family(pid):
    if not isinstance(pid,int) or pid<=0:return None
    result=binding.run(['ps','-axo','pid=,ppid='])
    if result.returncode:return None
    children={}
    for line in result.stdout.splitlines():
        values=line.split()
        if len(values)==2 and all(v.isdigit() for v in values):children.setdefault(int(values[1]),[]).append(int(values[0]))
    family=set();pending=[int(pid)]
    while pending and len(family)<256:
        current=pending.pop()
        if current not in family:family.add(current);pending.extend(children.get(current,[]))
    return None if pending else family


def writing_outputs(pid,paths):
    """A writing descendant proves a shell is live; a reader is not evidence."""
    family=process_family(pid)
    if not family:return None
    found=set()
    if Path('/proc/self/fd').exists():
        try:
            for child in family:
                folder=Path('/proc')/str(child)/'fd'
                try:descriptors=list(folder.iterdir())
                except FileNotFoundError:continue
                for fd in descriptors:
                    try:
                        target=os.readlink(fd)
                        if target not in paths:continue
                        flags=re.search(r'^flags:\s+([0-7]+)',(folder.parent/'fdinfo'/fd.name).read_text(),re.M)
                        if flags and int(flags.group(1),8)&os.O_ACCMODE in (os.O_WRONLY,os.O_RDWR):found.add(target)
                    except FileNotFoundError:continue
            return found
        except OSError:return None
    executable=shutil.which('lsof') or ('/usr/sbin/lsof' if Path('/usr/sbin/lsof').exists() else None)
    if not executable:return None
    try:
        result=subprocess.run([executable,'-nP','-a','-p',','.join(map(str,sorted(family))),'-Fpan'],capture_output=True,text=True,timeout=3)
        if result.returncode not in (0,1) or (result.returncode and result.stderr):return None
        access=None
        for line in result.stdout.splitlines():
            if line.startswith(('p','f')):access=None
            elif line.startswith('a'):access=line[1:]
            elif line.startswith('n') and access in ('w','u') and line[1:] in paths:found.add(line[1:])
        return found
    except (OSError,subprocess.TimeoutExpired):return None


def claude_jobs(path,sid,pid,now=None):
    now=time.time() if now is None else now
    calls={};starts={};ends={};partial=False
    for index,record in enumerate(binding.reverse_json(path)):
        if index>=MAX_RECORDS:partial=True;break
        if record.get('isSidechain'):continue
        message=record.get('message') or {};content=message.get('content') or []
        at=timestamp(record.get('timestamp'))
        origin=record.get('origin') or {}
        if isinstance(origin,dict) and origin.get('kind')=='task-notification':
            text=content_text(content)
            def field(name):
                match=re.search('<'+name+'>(.*?)</'+name+'>',text,re.S)
                return match.group(1).strip() if match else ''
            task=field('task-id');status=field('status')
            if task and status in ('completed','failed','error','killed','stopped') and task not in ends:
                ends[task]=dict(status='completed' if status=='completed' else 'failed' if status in ('failed','error') else 'stopped',
                                at=at,summary=field('summary')[:500])
        for block in content if isinstance(content,list) else []:
            if not isinstance(block,dict):continue
            if block.get('type')=='tool_use' and block.get('name')=='Bash':
                calls.setdefault(block.get('id'),dict(args=block.get('input') or {},at=at))
            elif block.get('type')=='tool_result':
                info=record.get('toolUseResult')
                task=info.get('backgroundTaskId') if isinstance(info,dict) else None
                if not isinstance(task,str) or task in starts or len(starts)>=MAX_JOBS:continue
                text=content_text(block.get('content'))
                match=re.search(r'Output is being written to:\s*(/[^\n]+?\.output)(?:\.|\s|$)',text)
                starts[task]=dict(call=block.get('tool_use_id'),at=at,file=output_path(match.group(1),sid,task) if match else None)
    paths={v['file'] for k,v in starts.items() if v['file'] and k not in ends}
    writers=writing_outputs(pid,paths) if paths else set()
    jobs=[]
    for task,start in starts.items():
        call=calls.get(start['call']) or {};args=call.get('args') or {};end=ends.get(task)
        began=call.get('at') or start['at']
        # Missing old notifications are not proof that an old shell is still running.
        live=start['file'] in writers if writers is not None else False
        if end:
            if not end['at'] or now-end['at']>RECENT_SECONDS:continue
            status=end['status']
        elif live:status='running'
        elif task==next(iter(starts)) or (start['at'] and now-start['at']<=RECENT_SECONDS):status='unknown'
        else:continue
        output,updated=output_tail(start['file'])
        seconds=max(0,round(((end or {}).get('at') or now)-began)) if began else None
        jobs.append(dict(id=task,status=status,title=str(args.get('description') or 'Shell komutu')[:180],
                         command=str(args.get('command') or '')[:1600],elapsed_seconds=seconds,
                         output=output or (end or {}).get('summary',''),
                         output_age_seconds=max(0,round(now-updated)) if updated and output else None))
    active=[job for job in jobs if job['status'] in ('running','unknown')]
    finished=[job for job in jobs if job['status'] not in ('running','unknown')]
    return dict(jobs=active+finished[:2],partial=partial,unavailable=writers is None)


def codex_jobs(sid):
    """Native command status covers processes still running after their first yield."""
    import json
    import sqlite3
    try:
        with binding.database(Path.home()/'.codex/thread_history_1.sqlite') as db:
            rows=db.execute("""SELECT item_json,created_at_ms FROM thread_items
                WHERE thread_id=? AND item_type='commandExecution' AND json_extract(item_json,'$.status')='inProgress'
                ORDER BY rollout_ordinal DESC LIMIT 6""",(sid,)).fetchall()
    except sqlite3.OperationalError:return dict(jobs=[],unavailable=True)
    jobs=[];now=time.time()
    for raw,at in rows:
        item=json.loads(raw)
        jobs.append(dict(id=item['id'],status='running',title='Shell komutu',command=str(item.get('command') or '')[:1600],
                         elapsed_seconds=max(0,round(now-at/1000)) if at else None,
                         output=tail_text(item.get('aggregatedOutput') or ''),output_age_seconds=None))
    return dict(jobs=jobs)
