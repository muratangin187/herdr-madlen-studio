"""Read a verified remote process through hc's existing machine connection."""
import base64
import json
from pathlib import Path
import re
import subprocess
import images
import history_cache
import zlib

# Run source from a private temporary directory, without installing a service or
# requiring hc on the remote PATH. get/read evidence comes from the local core.
WORKER = r'''
import base64,json,pathlib,sys,tempfile,types,zlib
request=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='madlen-chat-') as directory:
    root=pathlib.Path(directory)/'mods'/'madlen-chat';root.mkdir(parents=True)
    for name,source in request['sources'].items():(root/name).write_text(source)
    sys.path.insert(0,str(root))
    import bridge,images,history_cache
    sys.madlen_remote_worker=True
    # Reuse decoded attachments across polls instead of decoding them in a
    # throwaway source directory on every request.
    images.HOME=pathlib.Path.home()/'.cache/herdr-madlen-chat'
    images.HOME.mkdir(parents=True,exist_ok=True,mode=0o700)
    t=request['terminal'];fg=t['foreground'];kind=request['kind']
    bridge.terminal=lambda address:(t,kind,fg['pid'])
    original=bridge.b.run
    def run(args):
        if args[:2]==['hc','read']:return types.SimpleNamespace(returncode=0,stdout=json.dumps({'text':request['screen']}))
        return original(args)
    bridge.b.run=run
    try:
        result=bridge.snapshot(request['address'],request.get('limit'))
        result['process_pid']=fg['pid']
        for message in result['messages']:
            for attachment in message.get('attachments',[]):
                if attachment.get('path'):
                    path=images.HOME/attachment['path']
                    if path.name not in request.get('cached_images',[]):
                        attachment['blob']=base64.b64encode(path.read_bytes()).decode()
                        del attachment['path']
        result=history_cache.delta(result,request.get('known'))
        packed=zlib.compress(json.dumps(result,ensure_ascii=False,separators=(',',':')).encode(),3)
        print(json.dumps({'packed':base64.b64encode(packed).decode()}))
    except Exception as error:print(json.dumps({'error':str(error)},ensure_ascii=False))
'''


def split(address):
    if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_-]+',address):
        raise ValueError('Geçersiz uzak terminal adresi.')
    return address.split('/',1)


def snapshot(address,limit=None):
    import bridge
    machine,local=split(address)
    t,kind,pid=bridge.terminal(address)
    previous=history_cache.load(address,limit,t,kind)
    screen=bridge.b.run(['hc','read',address,'--lines','0','--json'])
    if screen.returncode:raise ValueError('Uzak terminal okunamadı; makine bağlantısını kontrol edin.')
    folder=Path(__file__).parent
    request=dict(limit=limit,known=history_cache.known(previous),cached_images=[p.name for p in (images.HOME/'data/madlen-chat/images').glob('*') if p.suffix!='.json'],address=local,terminal=t,kind=kind,screen=json.loads(screen.stdout).get('text',''),
                 sources={name:(folder/name).read_text() for name in ('bridge.py','binding.py','images.py','clipboard.py','history_cache.py','activity.py')})
    try:
        response=subprocess.run(['hc','exec','--on',machine,'--timeout','25','--stdin','python3','-c',WORKER],input=json.dumps(request),capture_output=True,text=True,timeout=30)
    except subprocess.TimeoutExpired:raise ValueError('Uzak makine zamanında yanıt vermedi. Yenileyerek tekrar deneyin.')
    if response.returncode:raise ValueError('Uzak sohbet okunamadı. Makine bağlantısını ve Python 3.9+ kurulumunu kontrol edin.')
    result=json.loads(response.stdout)
    if 'packed' in result:result=json.loads(zlib.decompress(base64.b64decode(result['packed'],validate=True)))
    if result.get('error'):raise ValueError(result['error'])
    result=history_cache.merge(result,previous)
    result['terminal']=address
    # Show remote questions, but never enable the local permission-key action.
    prompt=result.get('prompt')
    if prompt and prompt.get('kind') not in ('question','blocked'):
        result['prompt']=dict(kind='blocked',summary=prompt.get('summary') or prompt.get('title') or 'İzin gerekiyor. Terminal görünümünden yanıtlayın.')
    for message in result['messages']:
        for attachment in message.get('attachments',[]):
            blob=attachment.pop('blob',None)
            if blob:
                try:attachment.update(images.keep(base64.b64decode(blob,validate=True)))
                except (ValueError,OSError):attachment.update(missing=True)
    history_cache.save(address,limit,t,kind,result)
    return result


def send(address,expected,text,attachments=None,mode='normal'):
    import bridge
    split(address)
    if attachments:raise ValueError('Uzak oturumlara görsel gönderimi henüz desteklenmiyor. Metin gönderebilir veya Terminal görünümünü kullanabilirsiniz.')
    if not text.strip():raise ValueError('Mesaj boş olamaz.')
    if len(text)>50000 or text.lstrip().startswith('/'):raise ValueError('Bu mesaj için Terminal görünümünü kullanın.')
    # Delivery needs a freshly verified session and readiness, not its full history.
    data=snapshot(address,1)
    if mode not in ('normal','steer'):raise ValueError('Geçersiz gönderim biçimi.')
    if data['session']!=expected and data.get('process_key')!=expected:raise ValueError('Oturum değişti. Sohbeti yenileyip tekrar deneyin.')
    # Re-read readiness immediately before delivery; never force a blocked agent.
    t,kind,pid=bridge.terminal(address)
    if pid!=data['process_pid']:raise ValueError('Terminaldeki işlem değişti. Sohbeti yenileyin.')
    state=(t.get('status') or {}).get('state')
    if state=='working' and mode=='normal':return dict(deferred=True,delivery='not_sent')
    if state not in ('idle','done') and not (state=='working' and mode=='steer'):
        raise ValueError('Agent çalışıyor veya yanıt bekliyor. Taslağınız korundu.')
    if state=='working' and mode=='steer' and kind=='claude' and not bridge.claude_send_now_supported(address,t):
        raise ValueError('Şimdi yönlendirme için uzak makinede Claude Code 2.1.275 veya yenisi gerekiyor. Mesaj gönderilmedi.')
    guard=['--if','idle'] if state=='idle' else ['--if','working'] if state=='working' else []
    try:response=bridge.b.run(['hc','send',*guard,address,text])
    except Exception:
        return dict(error='Uzak mesaja gönderim onayı alınamadı. Tekrar göndermeden önce Terminal görünümünü kontrol edin.',delivery='uncertain')
    if response.returncode:return dict(error='Uzak mesaja gönderim onayı alınamadı. Tekrar göndermeden önce Terminal görünümünü kontrol edin.',delivery='uncertain')
    if state=='working' and mode=='steer' and kind=='claude':return bridge.steer_claude(address,t)
    return dict(ok=True)
