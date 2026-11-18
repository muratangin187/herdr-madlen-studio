"""Local, read-only transcript adapter; sending always targets the verified live TUI."""
import argparse
import hashlib
from html import unescape
import json
from pathlib import Path
import re
import sys
import binding as b
import images
import clipboard
import time
import sqlite3
import subprocess
import activity
from datetime import datetime


class UnboundSession(ValueError):
    def __init__(self,t,kind):
        super().__init__('Bu terminalin sohbet kaydı henüz kesin eşleştirilemedi.')
        self.terminal=t;self.kind=kind


def process_key(t,kind):
    fg=t.get('foreground') or {}
    identity=[t.get('created_ms'),t.get('pid'),fg.get('pid'),fg.get('argv'),kind]
    return 'process:'+hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()


def terminal(address):
    if not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)?', address):
        raise ValueError('Geçersiz terminal adresi.')
    r=b.run(['hc','get',address,'--json'])
    if r.returncode: raise ValueError('Oturum bulunamadı; terminal görünümüne dönün.')
    t=json.loads(r.stdout); fg=t.get('foreground') or {}
    app=(t.get('status') or {}).get('app') or fg.get('name','')
    kind='codex' if 'codex' in app else 'claude' if 'claude' in app else None
    if not kind or not fg.get('pid'): raise ValueError('Bu görünüm Codex ve Claude Code içindir.')
    return t,kind,fg['pid']


def resolve(address):
    t,kind,pid=terminal(address); home=Path.home(); root=home/'.codex'
    if kind=='codex':
        r=b.run(['hc','read',address,'--lines','0','--json'])
        screen=json.loads(r.stdout).get('text','') if r.returncode==0 else ''
        match=b.codex_thread(pid,root,screen)
        if match:return t,kind,match[0],Path(match[1]),True
    path=b.exact_log(pid,kind,home)
    if not path:raise UnboundSession(t,kind)
    sid=path.stem
    if kind=='codex':
        # A process-owned rollout and the projected SQLite history use the same
        # session ID; switching adapters must not strand queued messages.
        try:
            with path.open() as log:meta=json.loads(log.readline())
            identifier=(meta.get('payload') or {}).get('id')
            if meta.get('type')=='session_meta' and isinstance(identifier,str) and re.fullmatch(r'[\da-fA-F-]{36}',identifier):sid=identifier
        except (OSError,ValueError):pass
    return t,kind,sid,path,False


def delivery_target(address):
    try:return resolve(address)
    except UnboundSession as e:
        return e.terminal,e.kind,process_key(e.terminal,e.kind),None,False


def matches_target(current,expected):
    return current[2]==expected or process_key(current[0],current[1])==expected


def text_content(content):
    if isinstance(content,str):return content
    return '\n'.join(c.get('text','') for c in content or [] if isinstance(c,dict) and c.get('type') in ('text','input_text','output_text'))


def clean(text):
    # Host instructions and internal context are not user-authored chat bubbles.
    if text.startswith(('# AGENTS.md instructions','<environment_context>','<permissions instructions>')):return ''
    return text


def question_list(args):
    if isinstance(args,str):
        try:args=json.loads(args)
        except ValueError:return []
    if not isinstance(args,dict):return []
    questions=args.get('questions')
    return [q for q in questions if isinstance(q,dict)] if isinstance(questions,list) else []


def question_result(item,output,error=False,answers=None):
    """A receipt for an async question is not the person's answer."""
    value=output
    for _ in range(4):
        if isinstance(value,str):
            try:value=json.loads(value)
            except ValueError:break
        elif isinstance(value,dict):
            error=error or value.get('isError') is True
            if isinstance(value.get('structuredContent'),dict):value=value['structuredContent']
            elif isinstance(value.get('content'),list):value=text_content(value['content'])
            else:break
        else:break
    if error:
        item.update(question_state='failed',status='failed');return
    if isinstance(value,dict):
        answers=answers if answers is not None else value.get('answers')
    item['question_state']='answered' if answers else 'closed'
    if answers:item['answers']=answers
    elif isinstance(value,dict) and value.get('accepted') is True:item['question_state']='pending'
    elif isinstance(value,str) and value.startswith('User has answered your questions:'):
        item['question_state']='answered';item['answer_text']=value.split(':',1)[1].split('. You can now continue')[0].strip()[:10000]
    item['status']='inProgress' if item['question_state']=='pending' else 'completed'


def finalize_questions(messages):
    """Close superseded prompts without claiming an unrelated message answered them."""
    human_after=assistant_after=False
    for item in reversed(messages):
        if item['role']=='question' and item.get('question_state')=='pending':
            if human_after or (not item.get('async_question') and (assistant_after or item.get('turn_status')=='completed')):
                item['question_state']='closed';item['status']='completed'
        elif item['role']=='user' and not item.get('queued'):human_after=True
        elif item['role']=='assistant' and item.get('text'):assistant_after=True
    return messages


def tool(id,name,args,status=None,output=None):
    q=question_list(args) if any(s in name.lower() for s in ('request_user_input','askuserquestion')) else []
    detail=args if isinstance(args,str) else json.dumps(args,ensure_ascii=False,indent=2)
    item=dict(id=id,role='question' if q else 'tool',name=name,text=detail[:10000],status=status or 'completed',questions=q,output=(str(output)[:10000] if output is not None else ''))
    if q:
        item.update(question_state='pending',status='inProgress',async_question='request_user_input_async' in name.lower())
        if output is not None:question_result(item,output,error=status=='failed')
        elif status in ('completed','failed'):item.update(question_state='failed' if status=='failed' else 'closed',status=status)
    return item


def codex_item(item,ordinal):
    typ=item.get('type'); id=str(item.get('id') or ordinal)
    if typ=='userMessage':
        text=clean(text_content(item.get('content')))
        attachments=images.from_content(item.get('content',[]))
        return dict(id=id,role='user',text=text,attachments=attachments) if text or attachments else None
    if typ=='agentMessage':
        questions=question_list(item)
        if questions:
            return dict(id=id,role='question',text=item.get('text',''),question_intro=item.get('text',''),
                        questions=questions,question_state='pending',status='inProgress',async_question=True,phase=item.get('phase'))
        return dict(id=id,role='assistant',text=item.get('text',''),phase=item.get('phase'))
    if typ=='commandExecution':return tool(id,'Terminal komutu',item.get('command',''),item.get('status'),item.get('aggregatedOutput'))
    if typ in ('mcpToolCall','dynamicToolCall'):
        return tool(id,item.get('tool') or item.get('name') or 'Araç',item.get('arguments',{}),item.get('status'),item.get('error') or item.get('result'))
    if typ=='fileChange':return tool(id,'Dosya değişiklikleri',item.get('changes',[]),item.get('status'))
    if typ=='webSearch':return tool(id,'Web araması',item.get('query') or item.get('action') or {},'completed')
    if typ=='imageGeneration':return tool(id,'Görsel oluşturma',item.get('savedPath') or '',item.get('status'))
    return None


def projected(sid,limit=None):
    out=[];shown=0;more=False
    with b.database(Path.home()/'.codex/thread_history_1.sqlite') as db:
        try:
            rows=db.execute("""SELECT i.rollout_ordinal,i.item_json,i.turn_id,i.created_at_ms,
                t.status,t.duration_ms,t.final_agent_item_id
                FROM thread_items i LEFT JOIN thread_turns t ON t.thread_id=i.thread_id AND t.turn_id=i.turn_id
                WHERE i.thread_id=? AND i.item_type!='reasoning' ORDER BY i.rollout_ordinal DESC""",(sid,))
        except sqlite3.OperationalError:
            # Older schemas stay readable; without completion evidence, never fold.
            rows=((i,raw,None,None,None,None,None) for i,raw in db.execute("SELECT rollout_ordinal,item_json FROM thread_items WHERE thread_id=? AND item_type!='reasoning' ORDER BY rollout_ordinal DESC",(sid,)))
        for i,raw,turn,at,status,duration,final in rows:
            if limit and shown>=limit:more=True;break
            v=codex_item(json.loads(raw),i)
            if v and (v.get('text') or v.get('attachments') or v.get('questions')):
                v.update(turn_id=turn,at=at,turn_status=status,duration_ms=duration,final_id=final)
                out.append(v);shown+=v['role']!='tool'
    return finalize_questions(out[::-1]),more


def claude_system_event(record, text, rid):
    """Use producer metadata, never XML-looking user text, to identify automation."""
    origin=record.get('origin') or {}
    kind=origin.get('kind') if isinstance(origin,dict) else None
    automated=(kind=='task-notification' or record.get('turnOrigin')=='task_notification'
               or record.get('promptSource')=='system' or record.get('isMeta') is True)
    if not automated:return None
    def field(name):
        match=re.search(r'<'+name+r'>(.*?)</'+name+r'>',text,re.S)
        return unescape(match.group(1).strip()) if match else ''
    if kind=='task-notification' or record.get('turnOrigin')=='task_notification':
        status=field('status')
        summary=field('summary') or 'Arka plan görevi güncellendi.'
        state='failed' if status in ('failed','error') else 'inProgress' if status in ('running','in_progress') else 'completed' if status=='completed' else 'unknown'
        return tool('notification-'+rid,'Arka plan görevi',summary,state)
    return tool('system-'+rid,'Sistem bildirimi',text)


COMMAND=re.compile(r'(?:\s*<(command-name|command-message|command-args)>.*?</\1>)+\s*',re.S)
LOCAL_OUTPUT=re.compile(r'\s*<local-command-(stdout|stderr)>(.*?)</local-command-\1>\s*',re.S)
ANSI=re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
SHELL_INPUT=re.compile(r'\s*<bash-input>(.*?)</bash-input>\s*',re.S)
SHELL_OUTPUT=re.compile(r'\s*<bash-stdout>(.*?)</bash-stdout>\s*(?:<bash-stderr>(.*?)</bash-stderr>\s*)?',re.S)


def claude_local_command(text,rid):
    """Claude Code stores a typed slash command, a `!` shell command and their local output as plain user records."""
    if COMMAND.fullmatch(text):
        tags={k:v.strip() for k,v in re.findall(r'<(command-name|command-args)>(.*?)</\1>',text,re.S)}
        name=tags.get('command-name','')
        if name:return [dict(id=rid,role='user',text=' '.join(filter(None,(name if name.startswith('/') else '/'+name,tags.get('command-args',"")))),attachments=[])]
    match=LOCAL_OUTPUT.fullmatch(text)
    if match:
        output=ANSI.sub('',match.group(2)).strip()
        return [dict(id=rid,role='notice',text=output)] if output else []
    match=SHELL_INPUT.fullmatch(text)
    if match:return [dict(id=rid,role='user',text=match.group(1).strip(),shell=True,attachments=[])]
    match=SHELL_OUTPUT.fullmatch(text)
    if match:
        out=ANSI.sub('',match.group(1)).strip();error=ANSI.sub('',match.group(2) or '').strip()
        if out=='(Bash completed with no output)':out=''
        return [dict(id=rid,role='shell',text=out[:10000],error=error[:10000])]
    return None


def claude_queued(r,rid):
    """A message the person sent while Claude Code was working, read between two steps."""
    a=r.get('attachment')
    if not isinstance(a,dict) or a.get('type')!='queued_command' or a.get('isMeta'):return None
    origin=a.get('origin') or {}
    if not isinstance(origin,dict) or origin.get('kind')!='human' or a.get('commandMode') not in (None,'prompt'):return None
    text=clean(text_content(a.get('prompt')))
    return dict(id=rid,role='user',text=text,attachments=[],midturn=True) if text else None


def record_items(r,kind,ordinal,results):
    items=[]
    if r.get('isSidechain'):return items
    if kind=='claude' and r.get('type')=='attachment':
        queued=claude_queued(r,r.get('uuid') or str(ordinal))
        return [queued] if queued else items
    # API request blobs duplicate turns and include hidden prompt wrappers.
    if kind=='claude' and r.get('type') not in (None,'user','assistant'):return items
    p=r.get('payload',{}) if kind=='codex' else r.get('message',{})
    if kind=='codex' and r.get('type')!='response_item':return items
    role=p.get('role');content=p.get('content',[]);rid=r.get('uuid') or str(ordinal)
    if kind=='codex':
        typ=p.get('type')
        if typ=='message' and role in ('user','assistant') and p.get('channel')!='analysis':
            txt=clean(text_content(content))
            if txt:items.append(dict(id=rid,role=role,text=txt))
        elif typ in ('function_call','custom_tool_call'):
            items.append(tool(p.get('call_id',rid),p.get('name','Araç'),p.get('arguments') or p.get('input','')))
        elif typ in ('function_call_output','custom_tool_call_output'):results[p.get('call_id')]=p.get('output')
    elif r.get('isCompactSummary') is True:
        # Claude Code writes the compaction summary as a user record; nobody typed it.
        items.append(dict(id=rid,role='notice',text='Bağlam özetlendi (compact) · agent öncesini bu özetten hatırlıyor'))
    elif role in ('user','assistant'):
        txt=clean(text_content(content));attachments=images.from_content(content) if role=='user' else []
        if txt or attachments:
            event=claude_system_event(r,txt,rid) if role=='user' else None
            command=claude_local_command(txt,rid) if role=='user' and event is None and not attachments else None
            if command is not None:items.extend(command)
            else:items.append(event if event is not None else dict(id=rid,role=role,text=txt,attachments=attachments))
        for c in content if isinstance(content,list) else []:
            if c.get('type')=='tool_use':items.append(tool(c.get('id',rid),c.get('name','Araç'),c.get('input',{})))
            elif c.get('type')=='tool_result':
                # Keep answer metadata and errors alongside the result; the text
                # alone cannot tell a completed question from an unanswered one.
                result=r.get('toolUseResult') or {}
                results[c.get('tool_use_id')]=dict(output=text_content(c.get('content')),error=bool(c.get('is_error')),
                    answers=result.get('answers') if isinstance(result,dict) else None)
    for item in items:
        item['at']=timestamp_ms(r.get('timestamp'))
        if item['role']=='assistant' and kind=='codex':item['phase']=p.get('channel')
    return items


def timestamp_ms(value):
    try:
        if isinstance(value,(int,float)):return value
        return round(datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000)
    except (ValueError,TypeError,AttributeError,OverflowError):
        return None


def annotate_turns(chunks,kind):
    """Use producer completion events, never an idle terminal or a gap in text."""
    pending=[];turn=None;candidate=False

    def finish(completed=False,duration=None,identifier=None):
        nonlocal pending,turn,candidate
        final=next((m for m in reversed(pending) if m['role']=='assistant' and m.get('text')),None)
        identifier=identifier or (f"{kind}-{final['id']}" if final and completed else turn)
        for m in pending:
            m.update(turn_id=identifier,turn_status='completed' if completed else 'inProgress',
                     duration_ms=duration,final_id=final['id'] if final and completed else None)
        pending=[];turn=None;candidate=False

    for record,items in chunks:
        payload=record.get('payload') or {}
        event=payload.get('type') if record.get('type')=='event_msg' else None
        if kind=='codex' and event=='task_started':
            finish();turn=payload.get('turn_id')
        elif kind=='codex' and event in ('task_complete','turn_aborted'):
            finish(event=='task_complete',payload.get('duration_ms'),payload.get('turn_id'))
        elif kind=='claude' and record.get('type')=='system' and record.get('subtype')=='turn_duration':
            finish(True,record.get('durationMs'))
        if not items:continue
        if any(m['role']=='user' and m.get('queued') for m in items):
            finish(candidate)
            continue
        if any(m['role']=='user' and not m.get('midturn') and not m.get('shell') for m in items):
            if kind=='claude' and pending:finish(candidate)
            if turn is None:turn=f"{kind}-{items[0]['id']}"
        pending.extend(items)
        if kind=='claude' and record.get('type')=='assistant':
            candidate=(record.get('message') or {}).get('stop_reason')=='end_turn'
    finish(candidate if kind=='claude' else False)
    return [m for _,items in chunks for m in items]


def read_records(path,kind,limit=None):
    """Read from the end of the log; with a limit, stop after that many non-tool messages."""
    chunks=[]; results={}; shown=0; more=False
    # Claude Code's queue: enqueue, then remove (read mid-turn) or dequeue (sent as the next prompt).
    removed={}; dequeued=0
    for ordinal,r in enumerate(b.reverse_json(path)):
        if limit and shown>=limit:more=True;break
        if kind=='claude' and r.get('type')=='queue-operation':
            op,content=r.get('operation'),str(r.get('content') or '')
            if op=='remove':removed[content]=removed.get(content,0)+1
            elif op=='dequeue':dequeued+=1
            elif op=='enqueue':
                if removed.get(content):removed[content]-=1
                elif dequeued:dequeued-=1
                elif content.strip() and not content.startswith(('<task-notification','<agent-message')):
                    chunks.append((r,[dict(id='queued-'+str(r.get('timestamp') or ordinal),role='user',text=content,attachments=[],queued=True)]));shown+=1
            continue
        items=record_items(r,kind,ordinal,results)
        lifecycle=(kind=='codex' and r.get('type')=='event_msg' and (r.get('payload') or {}).get('type') in ('task_started','task_complete','turn_aborted')) or (kind=='claude' and r.get('type')=='system' and r.get('subtype')=='turn_duration' and not r.get('isSidechain'))
        if items or lifecycle:chunks.append((r,items));shown+=sum(m['role']!='tool' for m in items)
    out=annotate_turns(list(reversed(chunks)),kind)
    for m in out:
        if m['id'] in results:
            result=results[m['id']]
            data=result if kind=='claude' else dict(output=result)
            m['output']=str(data['output'])[:10000]
            if m['role']=='question':question_result(m,**data)
    return finalize_questions(out),more


def records(path,kind,limit=None):
    return read_records(path,kind,limit)[0]


RULE=re.compile(r'^[─━]{20,}$')
DASHES=re.compile(r'^[╌┄-]{20,}$')
OPTION=re.compile(r'^(?:❯\s*)?(\d)\.\s+(.*)$')


def parse_prompt(screen,summary=''):
    """Claude Code's permission dialog sits under the last full-width rule of the screen."""
    lines=[l.strip() for l in screen.splitlines()]
    rules=[i for i,l in enumerate(lines) if RULE.match(l)]
    if not rules:return None
    text=[];code=[];options=[];inside=False
    for l in lines[rules[-1]+1:]:
        if DASHES.match(l):inside=not inside;continue
        if not l or l.startswith('Tip:'):continue
        if l.startswith('Esc to cancel'):break
        match=OPTION.match(l)
        if match:options.append(dict(key=match.group(1),label=match.group(2)));continue
        if options:options[-1]['label']+=' '+l;continue
        (code if inside else text).append(l)
    if not options or not text:return None
    title,text=text[0],text[1:]
    question=text.pop() if text and text[-1].endswith('?') else ''
    fingerprint=hashlib.sha256(json.dumps([title,text,code,question,options],ensure_ascii=False).encode()).hexdigest()[:16]
    return dict(title=title,lines=text,code=code,question=question,options=options,summary=summary,fingerprint=fingerprint)


def parse_question_prompt(screen):
    """An open AskUserQuestion may not be persisted until the person answers it."""
    lines=[ANSI.sub('',line).strip() for line in screen.splitlines()]
    rules=[i for i,line in enumerate(lines) if RULE.fullmatch(line)]
    if len(rules)<2 or not any('to select' in line and ('Enter' in line or 'Space' in line) for line in lines[rules[-1]+1:]):return None
    body=lines[rules[-2]+1:rules[-1]]
    text=[];options=[]
    for line in body:
        line=line.lstrip('│ ').strip()
        if not line:continue
        match=OPTION.match(line)
        if match:
            options.append(dict(key=match.group(1),label=match.group(2),description=''))
        elif options:
            options[-1]['description']=' '.join(filter(None,(options[-1]['description'],line)))
        else:text.append(line)
    if not text or not options:return None
    title=text.pop(0).lstrip('☐☑□■ ').strip()
    question=' '.join(text) or title
    for option in options:
        if option['label'].rstrip('.')=='Type something':option['label']='Kendi yanıtınızı yazın (Terminal)'
    fingerprint=hashlib.sha256(json.dumps([title,question,options],ensure_ascii=False).encode()).hexdigest()[:16]
    return dict(kind='question',title=title,question=question,options=options,fingerprint=fingerprint)


def blocked_prompt(address,t,kind):
    status=t.get('status') or {}
    if status.get('state')!='blocked':return None
    prompt=None
    if kind=='claude':
        if status.get('kind')=='permission':
            try:
                prompt=permission_prompt(address,t)
                if prompt:prompt['kind']='permission'
            except (OSError,ValueError,subprocess.TimeoutExpired):pass
        elif status.get('kind')=='question':
            try:
                result=b.run(['hc','read',address,'--lines','0','--json'])
                if result.returncode==0:prompt=parse_question_prompt(json.loads(result.stdout).get('text',''))
            except (OSError,ValueError,subprocess.TimeoutExpired):pass
    return prompt or dict(kind='blocked',summary=str(status.get('msg') or 'Agent yanıtınızı bekliyor. Soruyu Terminal görünümünden kontrol edin.')[:5000])


def permission_prompt(address,t):
    status=t.get('status') or {}
    if status.get('state')!='blocked' or status.get('kind')!='permission':return None
    r=b.run(['hc','read',address,'--lines','0','--json'])
    return parse_prompt(json.loads(r.stdout).get('text',''),status.get('msg','')) if r.returncode==0 else None


def answer(address,fingerprint,key):
    """Press one option of the dialog the person saw, only while that same dialog is on screen."""
    if '/' in address:raise ValueError('Uzak oturumlarda izinleri Terminal görünümünden yanıtlayın.')
    t,kind,pid=terminal(address)
    prompt=permission_prompt(address,t) if kind=='claude' else None
    if not prompt or prompt['fingerprint']!=fingerprint:raise ValueError('İzin isteği değişti; sohbet yenileniyor, tekrar bakın.')
    if key not in [o['key'] for o in prompt['options']]:raise ValueError('Bu seçenek artık yok.')
    r=b.run(['hc','keys',address,key])
    if r.returncode:raise ValueError('Yanıt terminale iletilemedi. Terminal görünümünden devam edin.')
    return dict(ok=True)


def context_window(model):
    """Claude Code caches its account's model catalog; each model lists its context window."""
    folder=Path.home()/'.claude/cache/model-catalog'
    newest=lambda pattern:sorted(folder.glob(pattern),key=lambda p:p.stat().st_mtime,reverse=True)
    for path in newest('*-cc.json')+newest('*-ccd.json'):
        try:models=json.loads(path.read_text())['catalog']['config']['models']
        except (OSError,ValueError,KeyError,TypeError):continue
        for m in models if isinstance(models,list) else []:
            window=(m.get('runtime') or {}).get('max_input_tokens') if isinstance(m,dict) and m.get('id')==model else None
            if isinstance(window,int) and window>0:return window
    return None


def context_usage(path):
    """Context the next request starts from, counted like the status line's used_percentage."""
    tokens=model=None
    for i,r in enumerate(b.reverse_json(path)):
        if i>=2000:break
        if r.get('isSidechain'):continue
        if tokens is None and r.get('type')=='system' and r.get('subtype')=='compact_boundary':
            post=(r.get('compactMetadata') or {}).get('postTokens')
            if isinstance(post,int):tokens=post
        m=r.get('message') if r.get('type')=='assistant' else None
        if not isinstance(m,dict) or not m.get('model') or m.get('model')=='<synthetic>' or not isinstance(m.get('usage'),dict):continue
        if tokens is None:tokens=sum(m['usage'].get(k) or 0 for k in ('input_tokens','cache_creation_input_tokens','cache_read_input_tokens'))
        model=m['model'];break
    if not tokens or not model:return None
    window=context_window(model)
    return dict(tokens=tokens,window=window,percent=min(100,round(100*tokens/window)) if window else None)


def snapshot(address,limit=None):
    if "/" in address:
        import remote
        return remote.snapshot(address,limit)
    try:
        t,kind,sid,path,projection=resolve(address)
    except UnboundSession as e:
        t,kind=e.terminal,e.kind
        sid=process_key(t,kind);path=None;projection=False
    unbound=path is None
    messages,more=([],False) if unbound else projected(sid,limit) if projection else read_records(path,kind,limit)
    status=(t.get('status') or {}).get('state','idle')
    prompt=blocked_prompt(address,t,kind)
    context=context_usage(path) if kind=='claude' and path and not projection else None
    try:
        background=activity.claude_jobs(path,sid,(t.get('foreground') or {}).get('pid')) if kind=='claude' and path else activity.codex_jobs(sid) if kind=='codex' and projection else dict(jobs=[])
    except (OSError,ValueError,subprocess.TimeoutExpired):
        background=dict(jobs=[],unavailable=True)
    result=dict(terminal=address,session=sid,process_key=process_key(t,kind),unbound=unbound,
                kind=kind,status=status,messages=messages,more=more,prompt=prompt,context=context,background=background)
    # The remote worker has its own transport cache on the viewing computer.
    if not getattr(sys,'madlen_remote_worker',False):
        import history_cache
        history_cache.save(address,limit,t,kind,result)
    return result


def cached(address,limit=None):
    import history_cache
    # hc metadata is served locally even for remote terminals. Never contact SSH
    # before showing an already verified process's cached history.
    t,kind,pid=terminal(address)
    data=history_cache.load(address,limit,t,kind)
    return dict(data,cached=True,prompt=None) if data else None


def exit_agent(address,expected):
    """Explicit user exit: end only the process whose identity the Chat showed."""
    t,kind,pid=terminal(address)
    if not expected or process_key(t,kind)!=expected:
        raise ValueError('Agent işlemi değişti; kapatılmadı. Güncel sekmeden tekrar deneyin.')
    try:r=b.run(['hc','kill',address])
    except Exception:
        return dict(error='Agentın kapanışı doğrulanamadı. Eski sekmenin durumunu kontrol edin.')
    if r.returncode:return dict(error='Agent kapatılamadı. Eski sekme çalışmaya devam ediyor olabilir.')
    return dict(ok=True)


def send(address,expected,text,attachments=None,mode='normal'):
    if "/" in address:
        import remote
        return remote.send(address,expected,text,attachments,mode)
    if not text.strip() and not attachments:raise ValueError('Mesaj boş olamaz.')
    if len(text)>50000:raise ValueError('Bu mesaj çok uzun. Terminal görünümünü kullanın.')
    if mode not in ('normal','steer'):raise ValueError('Geçersiz gönderim biçimi.')
    t,kind,sid,path,projection=delivery_target(address)
    if sid!=expected and process_key(t,kind)!=expected:raise ValueError('Oturum değişti. Sohbeti yenileyip tekrar deneyin.')
    state=(t.get('status') or {}).get('state')
    if state=='working' and mode=='normal':return dict(deferred=True,delivery='not_sent')
    steer=state=='working' and mode=='steer'
    if state not in ('idle','done') and not steer:
        raise ValueError('Agent çalışıyor veya yanıt bekliyor. Terminal görünümünden devam edin.')
    if text.lstrip().startswith('/'):
        raise ValueError('Slash komutlarını terminal görünümünde kullanın.')
    if mode=='steer' and (attachments or text.lstrip().startswith('!')):
        raise ValueError('Görsel ve ! komutu agent hazır olduğunda gönderilebilir. Taslağınız korundu.')
    if steer and kind=='claude' and not claude_send_now_supported(address,t):
        raise ValueError('Şimdi yönlendirme için Claude Code 2.1.275 veya yenisi gerekiyor. Mesaj gönderilmedi; sıradan normal gönderimi kullanabilirsiniz.')
    staged=False
    if attachments:
        if not isinstance(attachments,list) or len(attachments)>3:raise ValueError('En fazla 3 görsel ekleyebilirsiniz.')
        paths=[]
        for path in attachments:
            source=(images.HOME/path).resolve()
            if source.parent!=(images.HOME/'data/madlen-chat/uploads').resolve() or not source.is_file():
                raise ValueError('Görsel eki geçersiz; yeniden ekleyin.')
            paths.append(source)
        # Compile/validate before placing anything into the terminal's composer.
        clipboard.helper()
        try:
            for path in paths:
                current=delivery_target(address)
                if not matches_target(current,expected) or (current[0].get('status') or {}).get('state') not in ('idle','done'):
                    raise ValueError('Oturum veya agent durumu değişti.')
                before=b.run(['hc','read',address,'--lines','0','--json'])
                screen=json.loads(before.stdout).get('text','')
                marker=r'\[(?:Pasted )?[Ii]mage[^\]\n]*\]'
                previous=len(re.findall(marker,screen))
                staged=True
                clipboard.attach(address,path)
                accepted=False
                for attempt in range(12):
                    result=b.run(['hc','read',address,'--lines','0','--json'])
                    after=json.loads(result.stdout).get('text','')
                    if len(re.findall(marker,after))>previous:accepted=True;break
                    time.sleep(0.15)
                if not accepted:raise ValueError('Görselin terminale eklendiği doğrulanamadı.')
            current=delivery_target(address)
            if not matches_target(current,expected):raise ValueError('Oturum değişti.')
            t=current[0]
            if (t.get('status') or {}).get('state') not in ('idle','done'):raise ValueError('Agent henüz hazır değil.')
        except Exception as e:
            return dict(error=str(e)+' Görsel terminal taslağında olabilir; Terminal görünümünden kontrol edip gönderin.',attachments_staged=staged,delivery='staged' if staged else 'not_sent')
    # Core only supports --if idle/working; a completed TUI reports done.
    # Default send still rejects blocked programs; never use --force.
    guard=['--if','idle'] if state=='idle' else ['--if','working'] if steer else []
    # Empty bracketed paste can make Claude re-read the image clipboard.
    try:
        r=b.run(['hc','keys',address,'enter'] if staged and not text.strip() else ['hc','send',*guard,address,text])
    except Exception:
        return dict(error='Gönderim onayı alınamadı. Tekrar göndermeden önce Terminal görünümünden kontrol edin.',delivery='uncertain',attachments_staged=staged)
    if r.returncode:
        if staged:return dict(error='Görseller terminal taslağına eklendi, mesaj gönderilemedi. Terminal görünümünden devam edin.',attachments_staged=True,delivery='staged')
        return dict(error=r.stderr or 'Gönderim doğrulanamadı. Terminal görünümünden kontrol edin.',delivery='uncertain')
    # started=false means the text was sent but no working signal arrived yet.
    # Treating that as a failed send would invite duplicate submissions.
    if steer and kind=='claude':
        return steer_claude(address,t)
    return dict(ok=True)


def claude_send_now_supported(address,t):
    try:
        argv=(t.get('foreground') or {}).get('argv') or []
        executable=argv[0] if argv and Path(argv[0]).is_absolute() else 'claude'
        args=['hc','exec','--on',address.split('/',1)[0],'--timeout','5','claude','--version'] if '/' in address else [executable,'--version']
        result=b.run(args)
        version=re.search(r'\b(\d+)\.(\d+)\.(\d+)\b',result.stdout)
        return result.returncode==0 and version is not None and tuple(map(int,version.groups()))>=(2,1,275)
    except Exception:return False


def steer_claude(address,original):
    """Claude's documented sendNow chord; never interrupt or answer a dialog."""
    try:
        current,kind,pid=terminal(address)
        if kind!='claude' or process_key(current,kind)!=process_key(original,kind):
            return dict(ok=True,steer_error='Mesaj iletildi; işlem değiştiği için yönlendirme tuşu gönderilmedi.')
        if (current.get('status') or {}).get('state')!='working':
            return dict(ok=True,steer_error='Mesaj iletildi; agentın durumu değiştiği için ek tuş gönderilmedi.')
        r=b.run(['hc','keys',address,'ctrl+x','ctrl+s'])
        if r.returncode:raise ValueError('Tuş iletilemedi.')
        return dict(ok=True)
    except Exception:
        return dict(ok=True,steer_error='Mesaj iletildi; hemen yönlendirme doğrulanamadı. Terminalden kontrol edin.')


def main():
    p=argparse.ArgumentParser();p.add_argument('--terminal',required=True);p.add_argument('--session');p.add_argument('--text');p.add_argument('--mode',choices=['normal','steer'],default='normal');p.add_argument('--attachments');p.add_argument('--limit',type=int);p.add_argument('--answer');p.add_argument('--fingerprint');p.add_argument('--cached',action='store_true');p.add_argument('--exit-agent',action='store_true');a=p.parse_args()
    try:
        result=(exit_agent(a.terminal,a.session) if a.exit_agent else answer(a.terminal,a.fingerprint,a.answer) if a.answer is not None
                else send(a.terminal,a.session,a.text,json.loads(a.attachments) if a.attachments else None,a.mode) if a.text is not None
                else cached(a.terminal,a.limit) if a.cached else snapshot(a.terminal,a.limit))
        print(json.dumps(result,ensure_ascii=False))
    except Exception as e:
        result=dict(error=str(e))
        if a.text is not None:result['delivery']='not_sent'
        print(json.dumps(result,ensure_ascii=False));return 1
    return 0

if __name__=='__main__':sys.exit(main())
