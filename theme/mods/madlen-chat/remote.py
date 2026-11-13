"""Read a verified remote process through hc's existing machine connection."""
import base64
import json
from pathlib import Path
import re
import subprocess
import images

# Run source from a private temporary directory, without installing a service or
# requiring hc on the remote PATH. get/read evidence comes from the local core.
WORKER = r'''
import base64,json,pathlib,sys,tempfile,types
request=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='madlen-chat-') as directory:
    root=pathlib.Path(directory)/'mods'/'madlen-chat';root.mkdir(parents=True)
    for name,source in request['sources'].items():(root/name).write_text(source)
    sys.path.insert(0,str(root))
    import bridge,images
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
        print(json.dumps(result,ensure_ascii=False))
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
    screen=bridge.b.run(['hc','read',address,'--lines','0','--json'])
    if screen.returncode:raise ValueError('Uzak terminal okunamadı; makine bağlantısını kontrol edin.')
    folder=Path(__file__).parent
    request=dict(limit=limit,cached_images=[p.name for p in (images.HOME/'data/madlen-chat/images').glob('*') if p.suffix!='.json'],address=local,terminal=t,kind=kind,screen=json.loads(screen.stdout).get('text',''),
                 sources={name:(folder/name).read_text() for name in ('bridge.py','binding.py','images.py','clipboard.py')})
    try:
        response=subprocess.run(['hc','exec','--on',machine,'--timeout','25','--stdin','python3','-c',WORKER],input=json.dumps(request),capture_output=True,text=True,timeout=30)
    except subprocess.TimeoutExpired:raise ValueError('Uzak makine zamanında yanıt vermedi. Yenileyerek tekrar deneyin.')
    if response.returncode:raise ValueError('Uzak sohbet okunamadı. Makine bağlantısını ve Python 3.9+ kurulumunu kontrol edin.')
    result=json.loads(response.stdout)
    if result.get('error'):raise ValueError(result['error'])
    result['terminal']=address
    # The permission card answers only local sessions; remote prompts stay in the Terminal.
    result.pop('prompt',None)
    for message in result['messages']:
        for attachment in message.get('attachments',[]):
            blob=attachment.pop('blob',None)
            if blob:
                try:attachment.update(images.keep(base64.b64decode(blob,validate=True)))
                except (ValueError,OSError):attachment.update(missing=True)
    return result


def send(address,expected,text,attachments=None):
    import bridge
    split(address)
    if attachments:raise ValueError('Uzak oturumlara görsel gönderimi henüz desteklenmiyor. Metin gönderebilir veya Terminal görünümünü kullanabilirsiniz.')
    if not text.strip():raise ValueError('Mesaj boş olamaz.')
    if len(text)>50000 or text.lstrip().startswith('/'):raise ValueError('Bu mesaj için Terminal görünümünü kullanın.')
    data=snapshot(address)
    if data['session']!=expected:raise ValueError('Oturum değişti. Sohbeti yenileyip tekrar deneyin.')
    # Re-read readiness immediately before delivery; never force a blocked agent.
    t,kind,pid=bridge.terminal(address)
    if pid!=data['process_pid']:raise ValueError('Terminaldeki işlem değişti. Sohbeti yenileyin.')
    if data['status'] not in ('idle','done') or (t.get('status') or {}).get('state') not in ('idle','done'):
        raise ValueError('Agent çalışıyor veya yanıt bekliyor. Taslağınız korundu.')
    guard=['--if','idle'] if t['status']['state']=='idle' else []
    response=bridge.b.run(['hc','send',*guard,address,text])
    if response.returncode:raise ValueError('Uzak mesaja gönderim onayı alınamadı. Tekrar göndermeden önce Terminal görünümünü kontrol edin.')
    return dict(ok=True)
