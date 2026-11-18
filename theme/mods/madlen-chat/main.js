import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex, TextView, Textarea, TextareaState } from 'gpui-base';
import { theme, settings, layout, shared, setShared, spaces, panes, terminals, run, exec, appHome, props, openOverlay, closeOverlay, knownAgents, checking, notify } from 'herdr';
import { conversation, visibleMessages, questionView, liveQuestionMessage } from './turns.js';
import { summarizeTool, summarizeGroup } from './tool-summary.js';
import { makeOutgoing, reconcileOutgoing, outgoingFor, mergeOutgoing, deliveryLabel, serializeOutbox, restoreOutbox } from './outbox.js';
import { linkifyFiles, linkTarget } from './links.js';
import { backgroundView, elapsedLabel } from './activity.js';
// Chat renders the newest PAGE messages (tools excluded); older ones load on request.
const PAGE=40;
// A `!` command's output shows this many lines until expanded.
const SHELL_LINES=12;
const find=(n,id)=>n?.id===id?n:(n?.children??[]).map(c=>find(c,id)).find(Boolean);
export default class MadlenChat extends View {
  init(_props,cx) {
    this.previewWidth=800;this.previewHeight=600;if(props()?.preview)return;
    this.readOnly=checking();
    this.openingLinks=new Set();this.linkStatus=null;
    this.exitFocus=cx.focus_handle();this.exitPending=false;this.exitError='';this.exitingTerminals=new Set();
    if(!this.readOnly)this.exitFocus.focus();
    this.imageDrafts={};this.outbox=restoreOutbox(localStorage.getItem('outbox.v1'));this.availableAgents=new Map();this.checkingAgents=new Set();this.launching=null;this.nextSend=0;this.pasting=false;this.staged={};this.limits={};this.raw=new Map();this.anchor=null;this.reload=new Set();this.answering=false;
    this.dragging=false;this.offset=0;this.viewport=400;this.viewportWidth=1000;this.contentHeight=400;this.follow=true;this.historyKey=0;this.data=null;this.error='';this.sendError='';this.pending=new Set();this.cache=new Map();this.positions=new Map();this.expanded={};this.drafts={};this.target=null;
    this.diskLoaded=new Set();this.updated=new Map();this.reports=new Map();this.background=null;
    this.input=TextareaState.new({placeholder:'Mesajınızı yazın…',rows:1});
    this.input.set_auto_grow(1,4);
    this.input.set_soft_wrap(true);
    this.input.on('submit',(e,cx)=>{if(!e.shift)this.send(cx);});
    this.input.on('paste_other',(_e,cx)=>this.pasteImages(cx));
    this.input.on('change',(_e,cx)=>{
      // Repaint only when the draft enters or leaves `!` command mode, not per keystroke.
      if(this.shellMode(this.input.value())!==this.shellDraft)cx.notify();
      if(this.target){
        this.drafts[this.target.terminal]=this.input.value();
        this.positions.set(this.target.terminal,{offset:this.offset,height:this.contentHeight,follow:this.follow,expanded:this.expanded});
      }});
    cx.timer.every(3000,cx=>{this.refresh(cx);this.prefetch(cx);this.pumpQueue(cx);});
    this.refresh(cx);this.prefetch(cx);
  }
  columnWidth(){return Math.max(1,Math.round(this.viewportWidth-72));}
  scrollThumb(y,cx){const track=Math.max(1,this.viewport-8-this.thumbHeight());this.offset=Math.max(0,Math.min(1,(y-this.thumbHeight()/2)/track))*this.maxOffset();this.follow=this.offset>=this.maxOffset()-3;cx.notify();}
  maxOffset(){return Math.max(0,this.contentHeight-this.viewport);}
  thumbHeight(){return Math.max(28,Math.min(this.viewport-8,(this.viewport-8)*this.viewport/Math.max(1,this.contentHeight)));}
  back() {run('layout.select',{stack:'conversation-surface',child:'main'});if(this.target)run('pane.focus',{pane:this.target.pane});}
  currentTarget() {
    const tab=spaces().find(s=>s.active)?.tabs?.find(t=>t.active)?.id;
    const candidates=panes().filter(p=>p.tab===tab&&p.terminal);
    const saved=shared('madlen.chat.target');
    const eligible=p=>['codex','claude'].some(a=>(p.app??p.program?.name??'').toLowerCase().includes(a));
    const p=candidates.find(p=>p.pane===saved?.pane&&eligible(p))
      ??candidates.find(p=>p.focused&&eligible(p))??candidates.find(eligible);
    return p?{terminal:p.terminal,pane:p.pane,tab}:null;
  }
  refresh(cx,force=false) {
    if(find(layout(),'conversation-surface')?.active!=='madlen-chat-view')return;
    const target=this.currentTarget();
    // An unsupported tab remains an explicit empty Chat view, not a forced mode switch.
    if(!target){
      if(this.target){this.drafts[this.target.terminal]=this.input.value();this.positions.set(this.target.terminal,{offset:this.offset,height:this.contentHeight,follow:this.follow,expanded:this.expanded});}
      this.target=null;this.data=null;this.error='';this.sendError='';return;
    }
    if(this.target?.terminal!==target.terminal){
      if(this.target){
        this.drafts[this.target.terminal]=this.input.value();
        this.positions.set(this.target.terminal,{offset:this.offset,height:this.contentHeight,follow:this.follow,expanded:this.expanded});
      }
      this.target=target;this.data=this.cache.get(target.terminal)??null;
      this.error='';this.sendError='';this.input.set_value(this.drafts[target.terminal]??'');
      const position=this.positions.get(target.terminal);
      this.expanded=position?.expanded??{};this.follow=position?.follow??true;
      this.contentHeight=position?.height??this.viewport;
      this.offset=this.follow?this.maxOffset():Math.min(position?.offset??0,this.maxOffset());this.historyKey++;
    }
    if(shared('madlen.chat.target')?.pane!==target.pane)setShared('madlen.chat.target',target);
    this.warm(target,cx);
    this.fetchSnapshot(target,cx,force);
  }
  warm(target,cx){
    if(this.diskLoaded.has(target.terminal))return;
    this.diskLoaded.add(target.terminal);
    if(this.cache.has(target.terminal))return;
    cx.spawn(async cx=>{
      try{
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-chat/bridge.py`,'--terminal',target.terminal,'--limit',String(this.limits[target.terminal]??PAGE),'--cached'],{timeout:4000});
        const data=JSON.parse(r.stdout);
        // A full refresh may win this race. A cache read must never overwrite it.
        if(!data?.session||data.error||this.cache.has(target.terminal))return;
        this.remember(target.terminal,data);
        if(this.target?.terminal===target.terminal){this.data=data;cx.notify();}
      }catch(_e){/* A missing/corrupt cache is an ordinary cold start. */}
    });
  }
  remember(terminal,data,raw){
    this.cache.delete(terminal);this.cache.set(terminal,data);
    if(raw!==undefined||!this.raw.has(terminal))this.raw.set(terminal,raw??JSON.stringify(data));
    let size=0;
    for(const key of [...this.cache.keys()].reverse()){
      size+=(this.raw.get(key)?.length??0);
      if((size>16*1024*1024||this.cache.size>12)&&key!==terminal&&key!==this.target?.terminal){this.cache.delete(key);this.raw.delete(key);}
    }
  }
  prefetch(cx){
    if(this.background)return;
    const active=this.currentTarget()?.terminal, now=Date.now();
    const live=new Map(terminals().map(t=>[t.address,t.status]));
    const candidates=panes().filter(p=>p.terminal&&['codex','claude'].some(a=>(p.app??p.program?.name??'').toLowerCase().includes(a)))
      .filter(p=>!this.pending.has(p.terminal)&&(this.reports.get(p.terminal)!==live.get(p.terminal)||now-(this.updated.get(p.terminal)??0)>=(live.get(p.terminal)==='working'||this.cache.get(p.terminal)?.background?.jobs?.some(j=>['running','unknown'].includes(j.status))?6000:30000)))
      .sort((a,b)=>(a.terminal===active?-1:b.terminal===active?1:0)||((this.updated.get(a.terminal)??0)-(this.updated.get(b.terminal)??0)));
    const p=candidates[0];if(!p)return;
    const target={terminal:p.terminal,pane:p.pane,tab:p.tab};
    this.background=target.terminal;this.warm(target,cx);this.fetchSnapshot(target,cx,false,true);
  }
  fetchSnapshot(target,cx,force=false,background=false){
    if(this.pending.has(target.terminal)){if(force)this.reload.add(target.terminal);return;}
    this.pending.add(target.terminal);
    this.reports.set(target.terminal,terminals().find(t=>t.address===target.terminal)?.status);
    cx.spawn(async cx=>{
      let changed=true;const limit=this.limits[target.terminal]??PAGE;
      try {
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-chat/bridge.py`,'--terminal',target.terminal,'--limit',String(limit)],{timeout:target.terminal.includes('/')?35000:20000});
        // The 3 s poll usually returns the same snapshot; re-rendering it would rebuild every message.
        const older=this.anchor?.terminal===target.terminal&&this.anchor.limit===limit;
        if(r.stdout===this.raw.get(target.terminal)&&this.cache.has(target.terminal)&&!this.cache.get(target.terminal).cached){
          if(older)this.anchor=null;
          changed=this.target?.terminal===target.terminal&&Boolean(this.error);
          if(changed)this.error='';
          return;
        }
        const data=JSON.parse(r.stdout);
        if(data.error)throw new Error(data.error);
        if(this.outbox?.length){this.outbox=reconcileOutgoing(this.outbox,data,target.terminal);this.persistOutbox();}
        this.raw.set(target.terminal,r.stdout);if(older)this.anchor.ready=true;
        const staged=this.staged[target.terminal];
        if(staged&&(data.session!==staged.session||data.messages.filter(m=>m.role==='user').at(-1)?.id!==staged.last)){
          delete this.staged[target.terminal];
          if(this.target?.terminal===target.terminal)this.sendError='';
        }
        this.remember(target.terminal,data);
        if(this.target?.terminal===target.terminal){this.data=data;this.error='';}
      }catch(e){if(this.target?.terminal===target.terminal)this.error=String(e.message??e);}
      finally{
        this.updated.set(target.terminal,Date.now());this.pending.delete(target.terminal);
        if(changed&&this.target?.terminal===target.terminal)cx.notify();
        if(background)this.background=null;
        if(this.reload.delete(target.terminal))this.fetchSnapshot(target,cx);
        if(background)this.prefetch(cx);this.pumpQueue(cx);
      }
    });
  }
  older(cx) {
    const target=this.target;if(!target)return;
    // Keep the message under the pointer in place while older ones grow the content above it.
    const limit=(this.limits[target.terminal]??PAGE)+PAGE;this.limits[target.terminal]=limit;
    this.anchor={terminal:target.terminal,fromBottom:this.contentHeight-this.offset,limit};this.follow=false;this.refresh(cx,true);cx.notify();
  }
  mono(){return settings()?.font_family??'Menlo';}
  // Claude Code runs a prompt that starts with `!` as a shell command (bash mode).
  shellMode(text){return this.data?.kind==='claude'&&text.trimStart().startsWith('!');}
  // Output of a `!` command typed in Claude Code: under the command, terminal-like, long output folded.
  shell(m,t){
    const id=`shell-${m.id}`, open=this.expanded[id], lines=(m.text||'').split('\n'), hidden=open?0:Math.max(0,lines.length-SHELL_LINES);
    return h_flex().id(id).flex_none().w_full().max_w(this.columnWidth()).mt(-8).justify_end()
      .child(v_flex().min_w(0).max_w(this.columnWidth()*0.84).px(14).py(10).gap(6).rounded(14).border(1).border_color(t.border).bg(t.surface).overflow_hidden().font_family(this.mono()).text_size(12.5)
        .when(Boolean(m.text),e=>e.child(div().min_w(0).text_color(t.foreground).child(hidden?lines.slice(0,SHELL_LINES).join('\n'):m.text)))
        .when(Boolean(m.error),e=>e.child(div().min_w(0).text_color(t.blocked).child(m.error)))
        .when(!m.text&&!m.error,e=>e.child(div().text_color(t.dim).child('Çıktı yok')))
        .when(lines.length>SHELL_LINES,e=>e.child(div().id(`toggle-${id}`).font_family('Helvetica Neue').text_size(12).text_color(t.dim).cursor_pointer().hover(s=>s.text_color(t.muted))
          .on_click((_e,cx)=>{this.follow=false;this.expanded[id]=!open;cx.notify();}).child(open?'▾ Daralt':`▸ ${hidden} satır daha`))));
  }
  // Claude Code is blocked on a permission dialog: show it here and press the chosen option's key.
  blockedPrompt(p,t){
    if(p.kind==='permission')return this.permission(p,t);
    const question=liveQuestionMessage(p,this.data?.messages);
    return question?this.question(question,t):div();
  }
  permission(p,t){
    return v_flex().id('permission-card').flex_none().w_full().max_w(this.columnWidth()).p(18).gap(12).rounded(18).border(1).border_color(t.blocked+'88').bg(t.surface)
      .child(h_flex().justify_between().items_center().child(div().font_semibold().text_size(12).text_color(t.blocked).child('İZİN İSTİYOR')).child(div().text_size(12).text_color(t.dim).child(p.title)))
      .children(p.lines.map(l=>div().text_color(t.muted).child(l)))
      .when(p.code.length>0,e=>e.child(div().p(12).rounded(10).bg(t.background).font_family(this.mono()).text_size(13).text_color(t.foreground).child(p.code.join('\n'))))
      .when(Boolean(p.question),e=>e.child(div().font_medium().child(p.question)))
      .child(v_flex().gap(6).children(p.options.map((o,i)=>h_flex().id(`permission-${o.key}`).px(12).py(9).gap(10).items_start().rounded(10).border(1).border_color(i===0?t.accent+'66':t.border).bg(i===0?t.selected:t.canvas)
        .cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,cx)=>this.answer(o.key,cx))
        .child(div().flex_none().w(16).text_color(t.dim).child(o.key)).child(div().min_w(0).flex_1().child(o.label)))))
      .child(h_flex().gap(10).justify_between().items_center().child(div().min_w(0).text_size(12).text_color(t.dim).child(this.answering?'Yanıt iletiliyor…':'Seçimin terminaldeki izin penceresine iletilir.'))
        .child(this.button('permission-terminal','Terminalde aç →',()=>this.back())));
  }
  answer(key,cx){
    const target=this.target,p=this.data?.prompt;if(!target||!p||this.answering)return;
    this.answering=true;this.sendError='';cx.notify();
    cx.spawn(async cx=>{
      try{
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-chat/bridge.py`,'--terminal',target.terminal,'--answer',key,'--fingerprint',p.fingerprint],{timeout:20000});
        const result=JSON.parse(r.stdout);if(result.error)throw new Error(result.error);
      }catch(e){if(this.target?.terminal===target.terminal)this.sendError=String(e.message??e);}
      finally{this.answering=false;this.refresh(cx,true);cx.notify();}
    });
  }
  // Same count as Claude Code's status line (context_window.used_percentage).
  contextMeter(c,t){
    const n=v=>String(v).replace(/\B(?=(\d{3})+(?!\d))/g,'.'), pct=c.percent, known=pct!=null, full=known&&pct>=80;
    return div().id('chat-context').flex_none().w(24).h(3).rounded_full().bg(t.border).overflow_hidden()
      .tooltip(known?`Bağlam %${pct}: ${n(c.tokens)} / ${n(c.window)} token`:`Bağlam: ${n(c.tokens)} token · pencere boyutu bilinmiyor`)
      .when(known,e=>e.child(div().h(3).w(Math.max(2,Math.round(pct*0.24))).rounded_full().bg(full?t.blocked:t.accent)));
  }
  notice(m,t){return h_flex().id(`notice-${m.id}`).flex_none().w_full().max_w(this.columnWidth()).gap(10).items_center().text_size(12).text_color(t.dim)
    .child(div().h(1).w(18).flex_none().bg(t.border)).child(div().min_w(0).child(m.text)).child(div().h(1).flex_1().min_w(12).bg(t.border));}
  pasteImages(cx,paths=[]) {
    const target=this.target;if(!target||this.pasting)return;
    if((this.imageDrafts[target.terminal]??[]).length>=3){this.sendError='Bir mesaja en fazla 3 görsel ekleyebilirsiniz.';cx.notify();return;}
    this.pasting=true;this.sendError='';cx.notify();
    cx.spawn(async cx=>{
      try{
        const args=[`${appHome()}/mods/madlen-chat/clipboard.py`,...paths.slice(0,3).flatMap(p=>['--file',p])];
        const result=JSON.parse((await exec('/usr/bin/python3',args,{timeout:100000})).stdout);
        if(result.error)throw new Error(result.error);
        const previous=this.imageDrafts[target.terminal]??[];
        this.imageDrafts[target.terminal]=[...previous,...result.images.filter(p=>!previous.some(x=>x.path===p.path))].slice(0,3);
      }catch(e){if(this.target?.terminal===target.terminal)this.sendError=String(e.message??e);}
      finally{this.pasting=false;cx.notify();}
    });
  }
  thumbnail(a,id,removable=false) {
    const t=theme();
    if(a.missing)return div().text_size(12).text_color(t.dim).child('Görsel artık bu bilgisayarda bulunamıyor.');
    const width=Math.min(removable?110:280,Math.max(60,this.columnWidth()*0.7));
    const scale=Math.min(width/a.width,(removable?76:190)/a.height,1);
    return v_flex().id(id).flex_none().gap(4)
      .child(div().rounded(10).overflow_hidden().cursor_pointer().tooltip('Görseli büyüt')
        .on_click(()=>openOverlay({mod:'madlen-chat',kind:'dialog',width:0.88,height:0.88,props:{preview:a}}))
        .child(image(a.path).w(Math.max(1,Math.round(a.width*scale))).h(Math.max(1,Math.round(a.height*scale)))))
      .when(removable,e=>e.child(div().id(`remove-${id}`).text_size(11).text_color(t.dim).cursor_pointer()
        .on_click((_e,cx)=>{if(!this.target)return;this.imageDrafts[this.target.terminal]=(this.imageDrafts[this.target.terminal]??[]).filter(x=>x.path!==a.path);cx.notify();}).child('Kaldır ×')));
  }
  sendingFor(terminal){return (this.outbox??[]).some(item=>item.terminal===terminal && item.state==='sending');}
  send(cx) {
    if(this.readOnly)return;
    const text=this.input.value().trim(), d=this.data, target=this.target, attachments=this.imageDrafts[target?.terminal]??[];
    if((!text&&!attachments.length)||!d||d.cached||!target||this.exitingTerminals?.has(target.terminal)||this.pasting||this.error||this.staged[target.terminal])return;
    if(this.currentTarget()?.terminal!==target.terminal)return;
    const status=terminals().find(t=>t.address===target?.terminal)?.status??d.status;
    const queue=status==='working'||this.outbox.some(x=>x.terminal===target.terminal&&['queued','sending','sent'].includes(x.state));
    if(!['idle','done','working'].includes(status)){this.sendError='Agent henüz hazır değil. Mesaj taslağınız korundu.';cx.notify();return;}
    const item=makeOutgoing(`outgoing-${Date.now()}-${++this.nextSend}`,target,d,text,attachments,this.shellMode(text));
    if(queue)item.state='queued';
    this.outbox.push(item);this.persistOutbox();
    this.sendError='';this.input.set_value('');this.drafts[target.terminal]='';this.imageDrafts[target.terminal]=[];
    this.follow=true;this.offset=this.maxOffset();cx.notify();
    if(!queue)this.deliver(item,cx);
  }
  persistOutbox(){try{localStorage.setItem('outbox.v1',serializeOutbox(this.outbox??[]));}catch(_e){/* Delivery still works if local storage is unavailable. */}}
  pumpQueue(cx){
    if(this.readOnly)return;
    const live=new Map(terminals().map(t=>[t.address,t.status]));
    const seen=new Set();
    for(const item of this.outbox??[]){
      if(item.state!=='queued'||seen.has(item.terminal)||this.exitingTerminals?.has(item.terminal))continue;seen.add(item.terminal);
      const data=this.cache.get(item.terminal);
      if(!data||data.cached||!['idle','done'].includes(data.status)||!['idle','done'].includes(live.get(item.terminal)))continue;
      if(data.session!==item.session||(item.process_key&&data.process_key!==item.process_key)||Date.now()<(item.notBefore??0))continue;
      if(this.outbox.some(x=>x!==item&&x.terminal===item.terminal&&['sending','sent','uncertain'].includes(x.state)))continue;
      this.deliver(item,cx);
    }
  }
  steer(item,cx){
    if(this.readOnly)return;
    if(this.currentTarget()?.terminal!==item.terminal)return;
    if(item.state!=='queued'||this.exitingTerminals?.has(item.terminal)||this.target?.terminal!==item.terminal||this.data?.session!==item.session||this.data?.cached||this.sendingFor(item.terminal))return;
    if(item.process_key&&item.process_key!==this.data.process_key)return;
    if(item.attachments.length||item.shell)return;
    item.mode='steer';this.deliver(item,cx);
  }
  deliver(item,cx) {
    if(this.readOnly)return;
    if(this.sendingFor(item.terminal) && item.state!=='sending')return;
    item.state='sending';item.error='';this.persistOutbox();cx.notify();
    cx.spawn(async cx=>{
      try{
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-chat/bridge.py`,'--terminal',item.terminal,'--session',item.session,'--text',item.inputText,...(item.mode==='steer'?['--mode','steer']:[]),...(item.attachments.length?['--attachments',JSON.stringify(item.attachments.map(a=>a.path))]:[])],{timeout:100000});
        const result=JSON.parse(r.stdout);
        if(result.deferred){item.state='queued';item.mode='normal';item.notBefore=Date.now()+3000;}
        else if(result.error || !result.ok){
          if(result.attachments_staged)this.staged[item.terminal]={session:item.session,last:[...item.baseline].at(-1)};
          if(item.observedId)item.state='sent';
          else {item.state=result.delivery==='not_sent'?'failed':'uncertain';item.error=result.error||'Gönderim doğrulanamadı. Terminalden kontrol edin.';}
        }else {item.state='sent';if(result.steer_error&&this.target?.terminal===item.terminal)this.sendError=result.steer_error;}
      }catch(e){
        item.state=item.observedId?'sent':'uncertain';item.error='Gönderim doğrulanamadı. Tekrar göndermeden önce Terminalden kontrol edin.';
      }finally{
        const snapshot=this.cache.get(item.terminal);
        if(snapshot)this.outbox=reconcileOutgoing(this.outbox,snapshot,item.terminal);
        this.persistOutbox();
        if(this.target?.terminal===item.terminal)this.refresh(cx,true);
        cx.notify();
      }
    });
  }
  retry(item,cx){
    if(item.state!=='failed'||this.target?.terminal!==item.terminal||this.data?.session!==item.session||this.sendingFor(item.terminal))return;
    this.deliver(item,cx);
  }
  restore(item,cx){
    if(!['failed','queued'].includes(item.state)||this.target?.terminal!==item.terminal||this.data?.session!==item.session)return;
    if(this.input.value().trim()||(this.imageDrafts[item.terminal]??[]).length){this.sendError='Önce mevcut taslağı gönderin veya temizleyin. Gönderilemeyen mesaj burada korunuyor.';cx.notify();return;}
    this.input.set_value(item.inputText);this.drafts[item.terminal]=item.inputText;
    this.imageDrafts[item.terminal]=item.attachments.map(a=>({...a}));this.outbox=this.outbox.filter(x=>x!==item);this.persistOutbox();this.sendError='';cx.notify();
  }
  dismissOutgoing(item,cx){
    if(this.readOnly||!['failed','uncertain'].includes(item.state)||this.currentTarget()?.terminal!==item.terminal
      ||this.target?.terminal!==item.terminal||this.data?.session!==item.session)return;
    this.outbox=this.outbox.filter(x=>x!==item);this.persistOutbox();cx.notify();this.pumpQueue(cx);
  }
  outgoingStatus(item){
    const failed=['failed','uncertain'].includes(item.state);
    const action=(id,label,callback)=>div().id(id).px(7).py(3).rounded(5).bg('#ffffff1a').cursor_pointer()
      .hover(s=>s.bg('#ffffff30')).on_click((_e,cx)=>callback(cx)).child(label);
    return v_flex().gap(5).text_size(11).text_color(failed?'#fecaca':'#ffffffb3')
      .child(h_flex().gap(5).items_center()
        .when(item.state==='sending',e=>e.child(svg('mods/madlen-chrome/spinner.svg').size(10).spin(900)))
        .child(div().min_w(0).child(deliveryLabel(item))))
      .when(item.state==='queued',e=>e.child(h_flex().gap(6)
        .when(!item.attachments.length&&!item.shell,x=>x.child(action(`steer-${item.id}`,'Şimdi yönlendir',cx=>this.steer(item,cx))))
        .child(action(`unqueue-${item.id}`,'Taslağa al',cx=>this.restore(item,cx)))))
      .when(item.state==='failed',e=>e.child(h_flex().gap(6)
        .child(action(`retry-${item.id}`,'Yeniden dene',cx=>this.retry(item,cx)))
        .child(action(`restore-${item.id}`,'Taslağa al',cx=>this.restore(item,cx)))))
      .when(item.state==='uncertain',e=>e.child(action(`check-${item.id}`,'Terminalde kontrol et',()=>this.back())))
      .when(failed,e=>e.child(action(`dismiss-${item.id}`,'Bu denemeyi kaldır',cx=>this.dismissOutgoing(item,cx))
        .tooltip('Yalnızca bu gönderim denemesini kaldırır; konuşma kaydını silmez ve bu denemeyi tekrar göndermez.')));
  }
  button(id,label,action,primary=false){const t=theme();return h_flex().id(id).h(30).px(12).gap(6).items_center().rounded(8).cursor_pointer().bg(primary?t.solid:t.surface).text_color(primary?t.solid_foreground:t.muted).hover(s=>s.bg(primary?t.accent:t.hover)).on_click((_e,cx)=>action(cx)).child(label);}
  iconButton(id,path,label,action,active=false){
    const t=theme();
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .bg(active?t.selected:t.canvas).text_color(active?t.accent:t.dim).hover(s=>s.bg(t.hover).text_color(t.foreground)).tooltip(label)
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();action(cx);})
      .child(svg(path).size(12));
  }
  openLink(url,context,cx){
    if(this.readOnly||this.data?.cached||this.currentTarget()?.terminal!==context.terminal
      ||this.target?.terminal!==context.terminal||this.data?.session!==context.session)return;
    const destination=linkTarget(url);if(!destination)return;
    const key=`${context.terminal}:${context.session}:${url}`;
    if(this.openingLinks.has(key))return;
    const remote=destination.kind==='file'&&context.terminal.includes('/');
    const status={...context,busy:true,label:remote?'Dosya indiriliyor…':'Açılıyor…'};
    this.linkStatus=status;this.openingLinks.add(key);cx.notify();
    cx.spawn(async cx=>{
      try{
        if(destination.kind==='web'){
          const result=await exec('/usr/bin/open',[destination.url],{timeout:15000});
          if(result.code!==0)throw new Error(result.stderr||'Bağlantı açılamadı.');
        }else{
          const response=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-outputs/files.py`,
            '--terminal',context.terminal,'--session',context.session,'--message',context.message,
            '--path',destination.path,'--action',remote?'download':'open'],{timeout:40000});
          const result=JSON.parse(response.stdout);
          if(result.error||response.code!==0)throw new Error(result.error||'Dosya açılamadı.');
          if(remote){
            if(!result.downloaded_path)throw new Error('Dosyanın indirme konumu alınamadı.');
            status.path=result.downloaded_path;status.label='İndirildi · Açılıyor…';cx.notify();
            const opened=await exec('/usr/bin/open',[...(result.item?.kind==='archive'?['-R']:[]),status.path],{timeout:15000});
            if(opened.code!==0)throw new Error(opened.stderr||'Dosya indirildi ancak uygulamada açılamadı.');
          }
        }
        status.label=remote?'İndirildi · Açıldı':'Açıldı';
      }catch(error){
        status.error=true;status.label=String(error.message??error);
        notify({title:status.path?'Dosya indirildi, açılamadı':'Bağlantı açılamadı',body:status.label,level:'error'});
      }finally{status.busy=false;this.openingLinks.delete(key);cx.notify();}
    });
  }
  linkFeedback(m,t){
    const status=this.linkStatus;
    if(!status||status.terminal!==this.target?.terminal||status.session!==this.data?.session||status.message!==m.id)return div();
    return h_flex().gap(8).items_center().text_size(11.5).text_color(status.error?t.blocked:t.dim)
      .when(status.busy,e=>e.child(svg('mods/madlen-chrome/spinner.svg').size(11).spin(900)))
      .child(div().child(status.label))
      .when(Boolean(status.path),e=>e.child(this.button(`reveal-link-${m.id}`,'İndirilenler’de göster',cx=>cx.spawn(async()=>{
        await exec('/usr/bin/open',['-R',status.path],{timeout:15000});
      }))));
  }
  markdown(id,text,message){
    const context={...this.target,session:this.data?.session,message};
    return TextView.markdown(`${this.data?.session??'loading'}-${id}`,linkifyFiles(text)).scrollable(false).w_full().min_w(0).text_size(15).text_color(theme().foreground)
      .on_link_click((url,cx)=>this.openLink(url,context,cx));
  }
  message(m,t) {
    const user=m.role==='user';
    return h_flex().id(`message-${m.id}`).w_full().max_w(this.columnWidth()).flex_none().items_start().when(user,e=>e.justify_end())
      .child(v_flex().min_w(0).max_w(user?this.columnWidth()*0.84:this.columnWidth()).when(!user,e=>e.flex_1().w_full()).gap(6).px(user?10:0).py(user?8:2).rounded(user?12:0).bg(user?'#5746db':t.canvas).text_color(user?'#ffffff':t.foreground).when(Boolean(m.queued||m.state==='queued'),e=>e.opacity(0.72))
        .child(m.shell?h_flex().gap(8).items_start().font_family(this.mono()).text_size(13.5).text_color('#ffffff').child(div().flex_none().opacity(0.7).child('!')).child(div().min_w(0).child(m.text))
          :user?div().text_size(15).text_color('#ffffff').child(m.text||'Görsel eklendi'):this.markdown(`md-${m.id}`,m.text||'',m.id))
        .when(!user&&this.linkStatus?.message===m.id,e=>e.child(this.linkFeedback(m,t)))
        .when(Boolean(m.attachments?.length),e=>e.child(h_flex().flex_wrap().gap(8).children(m.attachments.map((a,i)=>this.thumbnail(a,`attachment-${m.id}-${i}`)))))
        .when(Boolean(m.optimistic),e=>e.child(this.outgoingStatus(m)))
        .when(Boolean(m.queued||m.midturn),e=>e.child(div().text_size(11.5).text_color('#ffffffb3').child(m.queued?'Sırada · agent bir sonraki adımda okuyacak':'İş sürerken gönderildi'))));
  }
  toolColor(state,t){return state.kind==='failed'?t.blocked:state.kind==='working'?t.working:state.kind==='done'?t.done:t.dim;}
  toolStatus(state,t){return state.kind==='working'?svg('mods/madlen-chrome/spinner.svg').size(10).flex_none().text_color(t.working).spin(900)
    :div().w(10).flex_none().text_size(11).text_color(this.toolColor(state,t)).child(state.glyph);}
  tools(group,t){
    const id=group.id,open=Boolean(this.expanded[id]),summary=summarizeGroup(group.items);
    return h_flex().id(`toggle-${id}`).h(26).flex_none().mt(-6).mb(2).w_full().max_w(this.columnWidth()).min_w(0).gap(7).items_center().text_size(12).text_color(t.dim).cursor_pointer()
      .hover(s=>s.text_color(t.muted)).tooltip(open?'Araç listesini gizle':'Araç listesini göster')
      .on_click((_e,cx)=>{this.follow=false;this.expanded[id]=!open;cx.notify();})
      .child(div().flex_none().text_size(10).child(open?'▾':'▸'))
      .child(this.toolStatus(summary.state,t))
      .child(div().flex_none().child(`${group.items.length} araç işlemi`))
      .child(div().min_w(0).flex_1().truncate().text_color(t.dim).child(summary.preview));
  }
  toolRow(row,t){
    const summary=summarizeTool(row.item),open=Boolean(this.expanded[`tool-${row.key}`]);
    return h_flex().id(row.id).h(28).flex_none().mt(-14).w_full().max_w(this.columnWidth()).min_w(0).pl(14).gap(8).items_center().border_l(1).border_color(t.border)
      .text_size(12).cursor_pointer().hover(s=>s.bg(t.hover)).tooltip(summary.state.label)
      .on_click((_e,cx)=>{this.follow=false;this.expanded[`tool-${row.key}`]=!open;cx.notify();})
      .child(div().w(8).flex_none().text_size(9).text_color(t.dim).child(open?'▾':'▸'))
      .child(this.toolStatus(summary.state,t))
      .child(div().flex_none().max_w(150).truncate().text_color(t.muted).child(summary.label))
      .child(div().min_w(0).flex_1().truncate().text_color(t.dim).child(summary.subject))
      .child(div().id(`raw-toggle-${row.key}`).flex_none().h(20).px(6).flex().items_center().rounded(4).text_size(10.5)
        .text_color(this.expanded[`raw-${row.key}`]?t.accent:t.dim).hover(s=>s.bg(t.selected)).tooltip('Ham girdi ve çıktıyı göster')
        .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
        .on_click((_e,cx)=>{cx.stop_propagation();this.follow=false;this.expanded[`tool-${row.key}`]=true;this.expanded[`raw-${row.key}`]=!this.expanded[`raw-${row.key}`];cx.notify();}).child('Ham'));
  }
  toolDetail(row,t){
    const summary=summarizeTool(row.item),field=(label,value)=>h_flex().w_full().min_w(0).gap(10).items_start()
      .child(div().w(78).flex_none().text_color(t.dim).child(label))
      .child(div().min_w(0).flex_1().text_color(t.muted).child(value));
    const raw=(label,text)=>v_flex().w_full().min_w(0).gap(5)
      .child(div().text_color(t.dim).child(label))
      .child(div().w_full().min_w(0).p(10).rounded(6).bg(t.surface).font_family(this.mono()).text_size(12).text_color(t.muted).child(text||'İçerik yok'));
    return v_flex().id(row.id).flex_none().mt(-12).w_full().max_w(this.columnWidth()).min_w(0).pl(30).py(6).gap(7).border_l(1).border_color(t.border).text_size(12)
      .child(field('Durum',summary.state.label))
      .when(!row.raw,e=>e
        .children(summary.fields.map(f=>field(f.label,f.value)))
        .when(Boolean(summary.outcome),el=>el.child(field('Sonuç',summary.outcome)))
        .when(!summary.fields.length&&!summary.outcome,el=>el.child(div().text_color(t.dim).child('Ayrıntılar Ham görünümünde.'))))
      .when(row.raw,e=>e.child(raw('Girdi · ham kayıt',summary.rawInput))
        .when(Boolean(summary.rawOutput),el=>el.child(raw('Çıktı · ham kayıt',summary.rawOutput))));
  }
  part(m,t){return m.role==='work'?this.work(m,t):m.role==='tools'?this.tools(m,t):m.role==='tool-row'?this.toolRow(m,t):m.role==='tool-detail'?this.toolDetail(m,t):m.role==='question'?this.question(m,t):m.role==='notice'?this.notice(m,t):m.role==='shell'?this.shell(m,t):this.message(m,t);}
  work(group,t){
    const open=Boolean(this.expanded[group.id]);
    return h_flex().id(`toggle-${group.id}`).w_full().max_w(this.columnWidth()).min_w(0).h(26).flex_none().gap(6)
      .items_center().text_size(12).text_color(t.dim).cursor_pointer().hover(s=>s.text_color(t.muted))
      .tooltip(open?'Ara mesajları ve araç işlemlerini gizle':'Ara mesajları ve araç işlemlerini göster')
      .on_click((_e,cx)=>{this.follow=false;this.expanded[group.id]=!open;cx.notify();})
      .child(div().child(group.label)).child(div().text_size(10).child(open?'▾':'▸'));
  }
  question(m,t){
    const qv=questionView(m),key=`question-${m.id}`,open=this.expanded[key]??qv.pending;
    const color=qv.pending?t.accent:qv.answered?t.done:t.dim;
    return v_flex().id(key).flex_none().w_full().max_w(this.columnWidth()).min_w(0).p(16).gap(10).rounded(14).border(1).border_color(qv.pending?t.accent+'66':t.border).bg(qv.pending?t.selected:t.surface)
      .child(h_flex().id(`toggle-${key}`).justify_between().gap(12).items_center().cursor_pointer()
        .on_click((_e,cx)=>{this.follow=false;this.expanded[key]=!open;cx.notify();})
        .child(div().font_semibold().text_size(12).text_color(color).child(qv.label))
        .child(div().text_size(12).text_color(t.dim).child(open?'▾ Daralt':'▸ Ayrıntılar')))
      .when(Boolean(m.question_intro),e=>e.child(div().min_w(0).child(m.question_intro)))
      .children(qv.questions.map(q=>v_flex().min_w(0).gap(6)
        .when(q.title!==m.question_intro,e=>e.child(div().font_medium().child(q.title)))
        .when(q.selected.length>0,e=>e.child(div().text_color(t.done).child(`Yanıt: ${q.selected.join(', ')}`)))
        .when(open,e=>e.children(q.options.map(o=>{
          const label=typeof o==='string'?o:o?.label??'',selected=q.selected.includes(label);
          return v_flex().p(10).gap(4).rounded(10).border(1).border_color(selected?t.done:t.border).bg(t.canvas)
            .child(div().child(`${selected?'●':'○'}  ${label}`)).when(Boolean(o?.description),e=>e.child(div().text_size(12).text_color(t.dim).child(o.description)));
        })))))
      .when(Boolean(m.answer_text)&&open,e=>e.child(div().text_size(12).text_color(t.muted).child(m.answer_text)))
      .when(qv.pending,e=>e.child(h_flex().gap(12).justify_between().items_center()
        .child(div().min_w(0).text_size(12).text_color(t.dim).child(this.data?.cached?'Güncel soru durumu kontrol ediliyor…':'Yanıtınızı bu oturumun terminalinde verin.'))
        .when(!this.data?.cached,e=>e.child(this.button(`answer-${m.id}`,'Terminalde yanıtla →',()=>this.back(),true)))));
  }
  backgroundCard(activity,t){
    const color=activity.stale?t.dim:activity.running?t.working:activity.failed?t.blocked:activity.unknown||activity.unavailable?t.muted:t.done;
    return v_flex().id('background-activity').flex_none().ml(28).mr(44).mb(8).px(14).py(12).gap(8).rounded(12).border(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .when(activity.busy,e=>e.child(svg('mods/madlen-chrome/spinner.svg').size(12).spin(900)))
        .child(div().min_w(0).flex_1().font_semibold().text_size(12).text_color(color).child(activity.label))
        .child(this.button('background-terminal','Terminalde aç →',()=>this.back())))
      .when(Boolean(activity.detail),e=>e.child(div().text_size(12).text_color(t.dim).child(activity.detail)))
      .child(v_flex().id('background-jobs').min_h(0).max_h(200).overflow_y_scroll().gap(6).children(activity.jobs.map(job=>{
        const key=`background-job-${job.id}`,open=Boolean(this.expanded[key]);
        const state=job.status==='running'?'Çalışıyor':job.status==='completed'?'Tamamlandı':job.status==='failed'?'Başarısız':job.status==='stopped'?'Durduruldu':'Durum bilinmiyor';
        const latest=(job.output??'').split('\n').filter(Boolean).at(-1);
        const title=job.title==='Shell komutu'&&job.command?job.command.split('\n')[0]:job.title;
        return v_flex().id(key).min_w(0).flex_none().gap(6)
          .child(h_flex().id(`toggle-${key}`).min_w(0).gap(10).items_center().cursor_pointer()
            .on_click((_e,cx)=>{this.expanded[key]=!open;cx.notify();})
            .child(div().text_size(10).text_color(t.dim).child(open?'▾':'▸'))
            .child(div().min_w(0).flex_1().truncate().text_size(13).child(title||'Shell komutu'))
            .child(div().flex_none().text_size(11).text_color(t.dim).child([activity.stale?'Son kayıt':state,elapsedLabel(job.elapsed_seconds)].filter(Boolean).join(' · '))))
          .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(latest??(activity.stale?'Son kayıtta çıktı yok.':job.status==='running'?'Henüz çıktı yok · işlem sürüyor':job.status==='unknown'?'Çalıştığı henüz doğrulanamadı.':'Çıktı kaydı yok.')))
          .when(open,e=>e.child(v_flex().p(10).gap(8).rounded(8).bg(t.canvas).font_family(this.mono()).text_size(11)
            .when(Boolean(job.command),el=>el.child(div().child(job.command)))
            .when(Boolean(job.output),el=>el.child(div().text_color(t.muted).child(job.output.split('\n').slice(-6).join('\n'))))
            .when(job.output_age_seconds!=null,el=>el.child(div().text_size(11).text_color(t.dim).child(`Son çıktı ${elapsedLabel(job.output_age_seconds)} önce`)))));
      })));
  }
  launchContext(){
    const space=spaces().find(s=>s.active),tab=space?.tabs?.find(t=>t.active);
    const candidates=panes().filter(p=>p.tab===tab?.id&&p.terminal);
    const pane=candidates.find(p=>p.focused)??candidates[0];
    return {space,tab,pane,folder:pane?.cwd??space?.folder,key:`${tab?.id}:${pane?.terminal}`};
  }
  exitKey(event,cx){
    const m=event.modifiers??{};
    if(!m.control||m.alt||m.shift||m.platform||!['c','d'].includes(String(event.key).toLowerCase()))return;
    cx.stop_propagation();
    if(this.readOnly||this.exitPending)return;
    const target=this.currentTarget(),context=this.launchContext();
    if(!target){
      if(context.tab&&context.pane?.program?.key==='shell')run('tab.close',{id:context.tab.id,confirmed:true});
      return;
    }
    const data=this.data;
    if(this.target?.terminal!==target.terminal||!data?.process_key){this.sendError='Oturum doğrulanıyor; kapatmak için biraz sonra tekrar basın.';cx.notify();return;}
    const folder=panes().find(p=>p.pane===target.pane)?.cwd??context.folder;
    if(!folder||!context.space)return;
    const before=new Set(context.space.tabs.map(t=>t.id));
    this.exitPending=true;this.exitingTerminals.add(target.terminal);this.sendError='';this.exitError='';
    for(const item of this.outbox)if(item.terminal===target.terminal&&item.state==='queued'){
      item.state='failed';item.error='Agent kapatılıyor; mesaj gönderilmedi.';
    }
    this.persistOutbox();cx.notify();
    try{run('tab.new',{space:context.space.id,folder});this.exitFocus.focus();}
    catch(e){this.exitPending=false;this.exitingTerminals.delete(target.terminal);this.exitError=String(e.message??e);cx.notify();return;}
    cx.spawn(async cx=>{
      try{
        // The replacement must exist before the old terminal is ended, including
        // on a remote machine and when this was the space's only tab.
        let ready=false;
        for(let i=0;i<40;i++){
          const space=spaces().find(s=>s.id===context.space.id);
          if(space?.tabs?.some(t=>!before.has(t.id))){ready=true;break;}
          await cx.sleep(50);
        }
        if(!ready)throw new Error('Boş sekme hazırlanamadı; agent kapatılmadı.');
        this.exitFocus.focus();
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-chat/bridge.py`,'--terminal',target.terminal,'--exit-agent','--session',data.process_key],{timeout:20000});
        const result=JSON.parse(r.stdout);if(!result.ok)throw new Error(result.error??'Agent kapatılamadı.');
        this.cache.delete(target.terminal);this.raw.delete(target.terminal);
      }catch(e){this.exitError=String(e.message??e);}
      finally{this.exitPending=false;this.exitingTerminals.delete(target.terminal);this.refresh(cx);cx.notify();}
    });
  }
  launchAgent(agent,context,cx){
    if(this.readOnly)return;
    const current=this.launchContext();
    if(!agent?.installed||!agent.run?.length||!context.folder||current.key!==context.key||current.folder!==context.folder||this.launching===context.key)return;
    this.launching=context.key;this.launchError='';cx.notify();
    try{
      run('tab.new',{name:agent.name,space:context.space.id,folder:context.folder,argv:agent.run});
      if(agent.key==='antigravity')this.back();
    }catch(e){this.launching=null;this.launchError=String(e.message??e);cx.notify();}
  }
  launcher(cx,t){
    const context=this.launchContext(),where=context.space?.machine??'';
    if(!this.checkingAgents.has(where)){
      this.checkingAgents.add(where);
      this.availableAgents.set(where,shared('new-menu.agents')?.[where]??[]);
      cx.spawn(async cx=>{
        try{this.availableAgents.set(where,await knownAgents({on:context.space?.machine}));}
        catch(_e){this.launchError='Bu makinedeki agentlar kontrol edilemedi.';}
        cx.notify();
      });
    }
    const agents=this.availableAgents.get(where)??[];
    const shell=context.pane&&(!context.pane.app||context.pane.program?.key==='shell');
    return v_flex().w_full().max_w(this.columnWidth()).gap(12).py(20)
      .child(div().text_size(18).font_medium().child(shell?'Bir agent başlatın':'Bu uygulamanın sohbet görünümü henüz desteklenmiyor.'))
      .child(div().text_size(12).text_color(t.dim).child(context.folder??'Bir terminal sekmesi açın.'))
      .when(Boolean(this.exitPending),e=>e.child(div().text_size(12).text_color(t.working).child('Agent kapatılıyor…')))
      .when(Boolean(shell),e=>e.child(h_flex().gap(8).flex_wrap().children(
        [['codex','Codex'],['claude','Claude Code'],['antigravity','Antigravity']].map(([key,label])=>{
          const agent=agents.find(a=>a.key===key),enabled=Boolean(agent?.installed&&context.folder&&this.launching!==context.key);
          return this.button(`launch-${key}`,label,cx=>{if(enabled)this.launchAgent(agent,context,cx);},enabled)
            .when(!enabled,b=>b.opacity(0.5)).tooltip(agent?agent.installed?'Bu klasörde yeni oturum başlat':'Bu makinede kurulu değil':'Kurulum kontrol ediliyor…');
        }))))
      .when(Boolean(this.launchError),e=>e.child(div().text_size(12).text_color(t.blocked).child(this.launchError)))
      .child(div().text_size(12).text_color(t.dim).child(shell?'Seçtiğiniz agent bu klasörde yeni bir sekmede açılır.':'Terminal görünümünden devam edebilirsiniz.'));
  }
  render(cx) {
    if(props()?.preview){
      const a=props().preview,t=theme(),scale=Math.min(Math.max(1,this.previewWidth-40)/a.width,Math.max(1,this.previewHeight-64)/a.height,4);
      return v_flex().id('image-preview').size_full().min_w(0).min_h(0).p(16).gap(12).bg(t.canvas)
        .on_size_change((size,cx)=>{if(this.previewWidth!==size.width||this.previewHeight!==size.height){this.previewWidth=size.width;this.previewHeight=size.height;cx.notify();}})
        .child(h_flex().justify_between().child(div().text_color(t.muted).child('Görsel')).child(this.button('close-preview','Kapat ×',()=>closeOverlay(props().overlay))))
        .child(div().flex_1().min_h(0).flex().items_center().justify_center().child(image(a.path).w(Math.round(a.width*scale)).h(Math.round(a.height*scale))));
    }
    const current=this.currentTarget();
    if(current?.terminal!==this.target?.terminal)this.refresh(cx);
    const t=theme(), target=this.target, pane=panes().find(p=>p.pane===target?.pane);
    if(!current&&!this.readOnly){
      const key=this.launchContext().key;
      if(this.focusedLauncher!==key){
        this.focusedLauncher=key;
        cx.spawn(async _cx=>{if(!this.currentTarget()&&this.launchContext().key===key)this.exitFocus.focus();});
      }
    }else this.focusedLauncher=null;
    const activeTab=spaces().find(s=>s.active)?.tabs?.find(t=>t.active)?.id;
    const same=this.target?.terminal===target?.terminal&&target?.tab===activeTab;
    const data=same?this.data:null;
    const status=terminals().find(x=>x.address===target?.terminal)?.status??data?.status;
    const queue=status==='working'||this.outbox.some(x=>x.terminal===target?.terminal&&['queued','sending','sent'].includes(x.state));
    const sending=this.sendingFor(target?.terminal);
    const outgoing=outgoingFor(this.outbox??[],target?.terminal,data?.session);
    const waiting=outgoing.some(item=>['sending','sent'].includes(item.state));
    const waitingLabel=sending?'Mesaj iletiliyor…':'Yanıt bekleniyor…';
    const ready=data&&!data.cached&&!this.error&&!this.pasting&&!this.staged[target?.terminal]&&['idle','done','working'].includes(status);
    const shell=this.shellMode(this.input.value());this.shellDraft=shell;
    const groups=conversation(mergeOutgoing(data?.messages??[],outgoing),data?.cached?data.status:status);
    const background=backgroundView(data?.background,{cached:data?.cached,error:this.error});

    return v_flex().id('madlen-chat-root').track_focus(this.exitFocus).on_key_up((e,cx)=>this.exitKey(e,cx)).size_full().min_w(0).min_h(0).font_family('Helvetica Neue').text_size(14).text_color(t.foreground).bg(t.canvas)
      .on_mouse_up('left',()=>{this.dragging=false;}).on_hover(inside=>{if(!inside)this.dragging=false;})
      .child(h_flex().h(24).flex_none().px(6).gap(2).items_center().bg(t.canvas)
        .child(div().flex_1())
        .when(Boolean(data?.context),e=>e.child(this.contextMeter(data.context,t)))
        .when(!this.follow&&this.maxOffset()-this.offset>3,e=>e.child(this.iconButton('chat-latest','mods/madlen-chrome/chevron-down.svg','Son mesaja git',cx=>{this.follow=true;this.offset=this.maxOffset();cx.notify();})))
        .child(h_flex().gap(0).rounded(4)
          .child(this.iconButton('chat-selected','mods/madlen-pane/chat.svg','Sohbet',()=>{},true))
          .child(this.iconButton('back-terminal','mods/madlen-chrome/terminal.svg','Terminal',()=>this.back())))
        .when(Boolean(target),e=>e
          .children([['split-right','Sağa böl','right'],['split-down','Alta böl','down']].map(([icon,label,direction])=>
            this.iconButton(`chat-${icon}`,`mods/madlen-pane/${icon}.svg`,label,()=>{this.back();run('pane.split',{pane:target.pane,direction});})))
          .child(this.iconButton('chat-zoom',`mods/madlen-pane/${pane?.zoomed?'unzoom':'zoom'}.svg`,pane?.zoomed?'Bölünmüş görünüme dön':'Paneli büyüt',()=>run('pane.zoom',{pane:target.pane})))
          .child(this.iconButton('chat-close','mods/madlen-pane/close.svg','Paneli kapat',()=>run('pane.close',{pane:target.pane})))))
      .when(Boolean(this.error||this.sendError||this.exitError),e=>e.child(h_flex().flex_none().p(12).gap(12).bg(t.selected).text_color(t.accent).child(div().flex_1().child(this.exitError||this.sendError||this.error)).child(this.button('error-terminal','Terminale dön',()=>this.back()))))
      .child(div().id('chat-viewport').relative().flex_1().min_h(0).w_full().overflow_hidden()
        .on_size_change((size,cx)=>{const h=Math.round(size.height),w=Math.round(size.width);if(h!==this.viewport||w!==this.viewportWidth){this.viewport=h;this.viewportWidth=w;this.offset=this.follow?this.maxOffset():Math.min(this.offset,this.maxOffset());cx.notify();}})
        .on_mouse_move((e,cx)=>{if(!this.dragging||!e.local_position)return;this.scrollThumb(e.local_position.y-4,cx);})
        .on_scroll_wheel((e,cx)=>{const dy=e.delta?.y??0;if(!dy)return;this.offset=Math.max(0,Math.min(this.maxOffset(),this.offset-dy));this.follow=this.offset>=this.maxOffset()-3;cx.stop_propagation();cx.notify();})
        .child(v_flex().id(`chat-content-${this.historyKey}`).absolute().top(-this.offset).left(0).right(16).px(28).py(22).gap(18).items_start()
          .on_size_change((size,cx)=>{const h=Math.ceil(size.height);if(h!==this.contentHeight){
            const anchored=Boolean(this.anchor?.ready)&&this.anchor.terminal===this.target?.terminal&&h>this.contentHeight;
            this.contentHeight=h;
            this.offset=anchored?Math.max(0,Math.min(this.maxOffset(),h-this.anchor.fromBottom)):this.follow?this.maxOffset():Math.min(this.offset,this.maxOffset());
            if(anchored)this.anchor=null;cx.notify();}})
          .when(!data,e=>e.child(!target?this.launcher(cx,t):div().text_color(t.dim).child(this.error?'Terminal oturumunuz çalışmaya devam ediyor.':'Sohbet yükleniyor…')))
          .when(Boolean(data?.unbound),e=>e.child(div().text_color(t.dim).child('İlk mesajınızı buradan gönderebilirsiniz. Geçmiş, oturum oluştukça burada görünecek.')))
          .when(Boolean(data?.more),e=>e.child(h_flex().w_full().max_w(this.columnWidth()).justify_center().child(this.button('chat-older',this.pending.has(target?.terminal)?'Yükleniyor…':'Daha eski mesajları göster',cx=>this.older(cx)))))
          .children(visibleMessages(groups,this.expanded).map(m=>this.part(m,t)))
          .when(Boolean(data?.prompt)&&status==='blocked',e=>e.child(this.blockedPrompt(data.prompt,t)))
          .when(Boolean(data),e=>e.child(h_flex().flex_none().gap(8).items_center().text_size(12).text_color(status==='working'||waiting||background.busy?t.working:status==='blocked'||background.failed?t.blocked:background.unknown||background.unavailable||background.stale?t.dim:t.done)
            .when(status==='working'||waiting||background.busy,e=>e.child(svg('mods/madlen-chrome/spinner.svg').size(12).spin(900)))
            .child(div().child(data?.cached?'Kaydedilen geçmiş · güncelleniyor…':status==='working'?'Yanıt hazırlanıyor…':status==='blocked'?'Devam etmek için yanıtınız gerekiyor.':waiting?waitingLabel:data?.unbound?'Mesaj göndermeye hazır':['idle','done'].includes(status)?background.footer??'✓ Yanıt tamamlandı':'Oturum bağlanıyor…')))))
        .when(this.maxOffset()>0,e=>e.child(div().id('chat-scroll-track').absolute().right(3).top(4).bottom(4).w(9).rounded(5).bg(t.border+'55').cursor_pointer()
          .on_mouse_down('left',(event,cx)=>{if(!event.local_position)return;this.dragging=true;this.scrollThumb(event.local_position.y,cx);cx.stop_propagation();})
          .child(div().absolute().top((this.viewport-8-this.thumbHeight())*(this.maxOffset()?this.offset/this.maxOffset():0)).w(9).h(this.thumbHeight()).rounded(5).bg(t.dim+'88')))))
      .when(Boolean(target)&&background.show,e=>e.child(this.backgroundCard(background,t)))
      .when(Boolean(target),e=>e.child(div().on_key_up((e,cx)=>{if(e.key==='enter'&&!e.modifiers.shift){cx.stop_propagation();this.send(cx);}}).flex_none().w_full().pl(28).pr(44).mb(18).child(v_flex().w_full().max_w(this.columnWidth()).px(10).py(8).gap(8).rounded(14).border(1).border_color(shell?t.accent:t.border).bg(shell?t.background:t.surface)
        .when((this.imageDrafts[target?.terminal]??[]).length>0,e=>e.child(h_flex().gap(8).flex_wrap().children(this.imageDrafts[target.terminal].map((a,i)=>this.thumbnail(a,`draft-${i}`,true)))))
        .on_drop((event,cx)=>this.pasteImages(cx,event.paths??[]))
        .child(h_flex().w_full().gap(8).items_center()
          .child(Textarea.new(this.input).flex_1().min_w(0).text_size(shell?14:15).text_color(t.foreground).when(shell,e=>e.font_family(this.mono())))
          .when(shell,e=>e.child(div().flex_none().px(7).py(2).rounded(6).bg(t.accent+'26').text_color(t.accent).font_semibold().text_size(11).child('! KOMUT')))
          .when(this.pasting,e=>e.child(svg('mods/madlen-chrome/spinner.svg').size(12).text_color(t.accent).spin(900).tooltip('Görsel ekleniyor…')))
          .child(this.button('chat-send',shell?'Çalıştır →':queue?'Sıraya ekle →':'Gönder →',cx=>{if(ready)this.send(cx);},Boolean(ready)).flex_none())))));
  }
}
