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
    if not path:raise ValueError('Bu terminalin sohbet kaydı henüz kesin eşleştirilemedi. Bir yanıt oluştuktan sonra tekrar deneyin.')
    return t,kind,path.stem,path,False


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
    return [q for q in args.get('questions',[]) if isinstance(q,dict)]


def tool(id,name,args,status='completed',output=None):
    q=question_list(args) if any(s in name.lower() for s in ('request_user_input','askuserquestion')) else []
    detail=args if isinstance(args,str) else json.dumps(args,ensure_ascii=False,indent=2)
    return dict(id=id,role='question' if q else 'tool',name=name,text=detail[:10000],status=status,questions=q,output=(str(output)[:10000] if output else ''))


def codex_item(item,ordinal):
    typ=item.get('type'); id=str(item.get('id') or ordinal)
    if typ=='userMessage':
        text=clean(text_content(item.get('content')))
        attachments=images.from_content(item.get('content',[]))
        return dict(id=id,role='user',text=text,attachments=attachments) if text or attachments else None
    if typ=='agentMessage':return dict(id=id,role='assistant',text=item.get('text',''))
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
        for i,raw in db.execute("SELECT rollout_ordinal,item_json FROM thread_items WHERE thread_id=? AND item_type!='reasoning' ORDER BY rollout_ordinal DESC",(sid,)):
            if limit and shown>=limit:more=True;break
            v=codex_item(json.loads(raw),i)
            if v and (v.get('text') or v.get('attachments')):out.append(v);shown+=v['role']!='tool'
    return out[::-1],more


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
            elif c.get('type')=='tool_result':results[c.get('tool_use_id')]=text_content(c.get('content'))
    return items


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
                    chunks.append([dict(id='queued-'+str(r.get('timestamp') or ordinal),role='user',text=content,attachments=[],queued=True)]);shown+=1
            continue
        items=record_items(r,kind,ordinal,results)
        if items:chunks.append(items);shown+=sum(m['role']!='tool' for m in items)
    out=[m for items in reversed(chunks) for m in items]
    for m in out:
        if m['id'] in results:m['output']=str(results[m['id']])[:10000]
    return out,more


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


def snapshot(address,limit=None):
    if "/" in address:
        import remote
        return remote.snapshot(address,limit)
    t,kind,sid,path,projection=resolve(address)
    messages,more=projected(sid,limit) if projection else read_records(path,kind,limit)
    status=(t.get('status') or {}).get('state','idle')
    prompt=permission_prompt(address,t) if kind=='claude' else None
    return dict(terminal=address,session=sid,kind=kind,status=status,messages=messages,more=more,prompt=prompt)


def send(address,expected,text,attachments=None):
    if "/" in address:
        import remote
        return remote.send(address,expected,text,attachments)
    if not text.strip() and not attachments:raise ValueError('Mesaj boş olamaz.')
    if len(text)>50000:raise ValueError('Bu mesaj çok uzun. Terminal görünümünü kullanın.')
    t,kind,sid,path,projection=resolve(address)
    if sid!=expected:raise ValueError('Oturum değişti. Sohbeti yenileyip tekrar deneyin.')
    state=(t.get('status') or {}).get('state')
    # Claude Code queues a prompt typed while it works and reads it between steps, as in the terminal.
    queue=state=='working' and kind=='claude'
    if state not in ('idle','done') and not queue:
        raise ValueError('Agent çalışıyor veya yanıt bekliyor. Terminal görünümünden devam edin.')
    if text.lstrip().startswith('/'):
        raise ValueError('Slash komutlarını terminal görünümünde kullanın.')
    if queue and (attachments or text.lstrip().startswith('!')):
        raise ValueError('Görsel ve ! komutu agent hazır olduğunda gönderilebilir. Taslağınız korundu.')
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
                current=resolve(address)
                if current[2]!=expected or (current[0].get('status') or {}).get('state') not in ('idle','done'):
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
            current=resolve(address)
            if current[2]!=expected:raise ValueError('Oturum değişti.')
            t=current[0]
            if (t.get('status') or {}).get('state') not in ('idle','done'):raise ValueError('Agent henüz hazır değil.')
        except Exception as e:
            return dict(error=str(e)+' Görsel terminal taslağında olabilir; Terminal görünümünden kontrol edip gönderin.',attachments_staged=staged)
    # Core only supports --if idle/working; a completed TUI reports done.
    # Default send still rejects blocked programs; never use --force.
    guard=['--if','idle'] if (t.get('status') or {}).get('state')=='idle' else ['--if','working'] if queue else []
    # Empty bracketed paste can make Claude re-read the image clipboard.
    r=b.run(['hc','keys',address,'enter'] if staged and not text.strip() else ['hc','send',*guard,address,text])
    if r.returncode:
        if staged:return dict(error='Görseller terminal taslağına eklendi, mesaj gönderilemedi. Terminal görünümünden devam edin.',attachments_staged=True)
        raise ValueError(r.stderr or 'Mesaj gönderilemedi.')
    result=json.loads(r.stdout)
    # started=false means the text was sent but no working signal arrived yet.
    # Treating that as a failed send would invite duplicate submissions.
    return dict(ok=True)


def main():
    p=argparse.ArgumentParser();p.add_argument('--terminal',required=True);p.add_argument('--session');p.add_argument('--text');p.add_argument('--attachments');p.add_argument('--limit',type=int);p.add_argument('--answer');p.add_argument('--fingerprint');a=p.parse_args()
    try:
        result=(answer(a.terminal,a.fingerprint,a.answer) if a.answer is not None
                else send(a.terminal,a.session,a.text,json.loads(a.attachments) if a.attachments else None) if a.text is not None else snapshot(a.terminal,a.limit))
        print(json.dumps(result,ensure_ascii=False))
    except Exception as e:
        print(json.dumps(dict(error=str(e)),ensure_ascii=False));return 1
    return 0

if __name__=='__main__':sys.exit(main())
