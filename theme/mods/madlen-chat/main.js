import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex, TextView, Textarea, TextareaState } from 'gpui-base';
import { theme, settings, layout, shared, setShared, spaces, panes, terminals, run, exec, appHome, props, openOverlay, closeOverlay } from 'herdr';
// Chat renders the newest PAGE messages (tools excluded); older ones load on request.
const PAGE=40;
// A `!` command's output shows this many lines until expanded.
const SHELL_LINES=12;
const find=(n,id)=>n?.id===id?n:(n?.children??[]).map(c=>find(c,id)).find(Boolean);
export default class MadlenChat extends View {
  init(_props,cx) {
    this.previewWidth=800;this.previewHeight=600;if(props()?.preview)return;
    this.imageDrafts={};this.pasting=false;this.staged={};this.limits={};this.raw=new Map();this.anchor=null;this.reload=new Set();this.answering=false;
    this.dragging=false;this.offset=0;this.viewport=400;this.viewportWidth=1000;this.contentHeight=400;this.follow=true;this.historyKey=0;this.data=null;this.error='';this.sendError='';this.pending=new Set();this.cache=new Map();this.positions=new Map();this.sending=false;this.expanded={};this.drafts={};this.target=null;
    this.input=TextareaState.new({placeholder:'Mesajınızı yazın…',rows:3});
    this.input.set_auto_grow(3,10);
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
    cx.timer.every(3000,cx=>this.refresh(cx));
    this.refresh(cx);
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
    if(this.pending.has(target.terminal)){if(force)this.reload.add(target.terminal);return;}
    this.pending.add(target.terminal);
    cx.spawn(async cx=>{
      let changed=true;const limit=this.limits[target.terminal]??PAGE;
      try {
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-chat/bridge.py`,'--terminal',target.terminal,'--limit',String(limit)],{timeout:target.terminal.includes('/')?35000:20000});
        // The 3 s poll usually returns the same snapshot; re-rendering it would rebuild every message.
        const older=this.anchor?.terminal===target.terminal&&this.anchor.limit===limit;
        if(r.stdout===this.raw.get(target.terminal)&&this.cache.has(target.terminal)){
          if(older)this.anchor=null;
          changed=this.target?.terminal===target.terminal&&Boolean(this.error);
          if(changed)this.error='';
          return;
        }
        const data=JSON.parse(r.stdout);
        if(data.error)throw new Error(data.error);
        this.raw.set(target.terminal,r.stdout);if(older)this.anchor.ready=true;
        const staged=this.staged[target.terminal];
        if(staged&&(data.session!==staged.session||data.messages.filter(m=>m.role==='user').at(-1)?.id!==staged.last)){
          delete this.staged[target.terminal];this.imageDrafts[target.terminal]=[];
          if(this.target?.terminal===target.terminal)this.sendError='';
        }
        this.cache.delete(target.terminal);this.cache.set(target.terminal,data);
        if(this.cache.size>12){const old=this.cache.keys().next().value;this.cache.delete(old);this.raw.delete(old);}
        if(this.target?.terminal===target.terminal){this.data=data;this.error='';}
      }catch(e){if(this.target?.terminal===target.terminal)this.error=String(e.message??e);}
      finally{this.pending.delete(target.terminal);if(changed)cx.notify();if(this.reload.delete(target.terminal))this.refresh(cx);}
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
  permission(p,t){
    return v_flex().id('permission-card').flex_none().ml(40).w_full().max_w(this.columnWidth()-40).p(18).gap(12).rounded(18).border(1).border_color(t.blocked+'88').bg(t.surface)
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
    return h_flex().id('chat-context').flex_none().gap(7).items_center().text_size(12).text_color(full?t.blocked:t.muted)
      .tooltip(known?`Bağlam: ${n(c.tokens)} / ${n(c.window)} token`:`Bağlam: ${n(c.tokens)} token · pencere boyutu bilinmiyor`)
      .when(known,e=>e.child(div().w(40).h(5).rounded_full().bg(t.border).overflow_hidden().child(div().h(5).w(Math.max(2,Math.round(pct*0.4))).rounded_full().bg(full?t.blocked:t.accent))))
      .child(known?`Bağlam %${pct}`:`Bağlam ${Math.round(c.tokens/1000)}k token`);
  }
  notice(m,t){return h_flex().id(`notice-${m.id}`).flex_none().w_full().max_w(this.columnWidth()).pl(40).gap(10).items_center().text_size(12).text_color(t.dim)
    .child(div().h(1).w(18).flex_none().bg(t.border)).child(div().min_w(0).child(m.text)).child(div().h(1).flex_1().min_w(12).bg(t.border));}
  pasteImages(cx,paths=[]) {
    const target=this.target;if(!target||this.pasting||this.sending)return;
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
        .on_click((_e,cx)=>{if(this.sending||this.staged[this.target?.terminal])return;this.imageDrafts[this.target.terminal]=(this.imageDrafts[this.target.terminal]??[]).filter(x=>x.path!==a.path);cx.notify();}).child('Kaldır ×')));
  }
  send(cx) {
    const text=this.input.value().trim(), d=this.data, target=this.target, attachments=this.imageDrafts[target?.terminal]??[];
    if((!text&&!attachments.length)||!d||this.sending||this.pasting||this.error||this.staged[target?.terminal])return;
    const status=terminals().find(t=>t.address===target?.terminal)?.status??d.status;
    // While Claude Code works, a send joins its queue and is read between steps, as typed in the terminal.
    const queue=status==='working'&&d.kind==='claude'&&!target.terminal.includes('/');
    if(!['idle','done'].includes(status)&&!queue){this.sendError='Agent henüz hazır değil. Mesaj taslağınız korundu.';cx.notify();return;}
    if(queue&&(attachments.length||text.startsWith('!'))){this.sendError='Görsel ve ! komutu agent hazır olduğunda gönderilebilir. Taslağınız korundu.';cx.notify();return;}
    this.sendError='';this.sending=true;cx.notify();
    cx.spawn(async cx=>{
      try{
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-chat/bridge.py`,'--terminal',target.terminal,'--session',d.session,'--text',text,...(attachments.length?['--attachments',JSON.stringify(attachments.map(a=>a.path))]:[])],{timeout:100000});
        const result=JSON.parse(r.stdout);if(result.error){if(result.attachments_staged)this.staged[target.terminal]={session:d.session,last:d.messages.filter(m=>m.role==='user').at(-1)?.id};throw new Error(result.error);}
        this.imageDrafts[target.terminal]=[];
        if(this.target?.terminal===target.terminal){this.input.set_value('');this.drafts[target.terminal]='';}
        this.refresh(cx);
      }catch(e){if(this.target?.terminal===target.terminal)this.sendError=String(e.message??e);}finally{this.sending=false;cx.notify();}
    });
  }
  button(id,label,action,primary=false){const t=theme();return h_flex().id(id).h(30).px(12).gap(6).items_center().rounded(8).cursor_pointer().bg(primary?t.solid:t.surface).text_color(primary?t.solid_foreground:t.muted).hover(s=>s.bg(primary?t.accent:t.hover)).on_click((_e,cx)=>action(cx)).child(label);}
  markdown(id,text){return TextView.markdown(`${this.data?.session??'loading'}-${id}`,text).scrollable(false).w_full().min_w(0).text_size(15).text_color(theme().foreground);}
  message(m,t) {
    const user=m.role==='user';
    return h_flex().id(`message-${m.id}`).w_full().max_w(this.columnWidth()).flex_none().gap(12).items_start().when(user,e=>e.justify_end())
      .when(!user,e=>e.child(div().size(24).mt(5).flex_none().rounded_full().bg(t.selected).flex().items_center().justify_center().text_color(t.accent).overflow_hidden().child(image('mods/madlen-heading/mascot.webp').size(24))))
      .child(v_flex().min_w(0).max_w(user?this.columnWidth()*0.84:this.columnWidth()-36).when(!user,e=>e.flex_1().w_full()).gap(8).p(user?16:4).rounded(18).bg(user?'#5746db':t.canvas).text_color(user?'#ffffff':t.foreground).when(Boolean(m.queued),e=>e.opacity(0.72))
        .child(m.shell?h_flex().gap(8).items_start().font_family(this.mono()).text_size(13.5).text_color('#ffffff').child(div().flex_none().opacity(0.7).child('!')).child(div().min_w(0).child(m.text))
          :user?div().text_size(15).text_color('#ffffff').child(m.text||'Görsel eklendi'):this.markdown(`md-${m.id}`,m.text||''))
        .when(Boolean(m.attachments?.length),e=>e.child(h_flex().flex_wrap().gap(8).children(m.attachments.map((a,i)=>this.thumbnail(a,`attachment-${m.id}-${i}`)))))
        .when(Boolean(m.queued||m.midturn),e=>e.child(div().text_size(11.5).text_color('#ffffffb3').child(m.queued?'Sırada · agent bir sonraki adımda okuyacak':'İş sürerken gönderildi'))));
  }
  tools(group,t){
    const id=group.id, open=this.expanded[id];
    return v_flex().id(id).flex_none().pl(40).mt(-6).mb(2).w_full().max_w(this.columnWidth()).min_w(0).items_start()
      .child(h_flex().id(`toggle-${id}`).h(24).gap(7).items_center().text_size(12).text_color(t.dim).cursor_pointer()
        .hover(s=>s.text_color(t.muted)).tooltip(open?'Araç ayrıntılarını gizle':'Araç ayrıntılarını göster')
        
        .on_click((_e,cx)=>{this.follow=false;this.expanded[id]=!open;cx.notify();})
        .child(div().text_size(10).child(open?'▾':'▸'))
        .child(div().child(`${group.items.length} araç işlemi`)))
      .when(open,e=>e.child(v_flex().w_full().mt(8).pl(14).pb(8).border_l(1).border_color(t.border).gap(10).children(group.items.map(m=>v_flex().gap(5).pt(10).border_t(1).border_color(t.border)
        .child(h_flex().gap(8).child(div().font_medium().child(m.name)).child(div().text_size(11).text_color(m.status==='failed'?t.blocked:t.dim).child(m.status==='failed'?'Hata':m.status==='inProgress'?'Çalışıyor':'Araç kaydı')))
        .child(this.markdown(`tool-${m.id}`,'```text\n'+m.text.slice(0,5000)+'\n```'))
        .when(Boolean(m.output),x=>x.child(this.markdown(`result-${m.id}`,'```text\n'+m.output.slice(0,5000)+'\n```')))))));
  }
  question(m,t){return v_flex().flex_none().ml(40).max_w(this.columnWidth()-40).p(20).gap(14).rounded(18).border(1).border_color(t.accent+'66').bg(t.selected)
    .child(h_flex().justify_between().child(div().font_semibold().text_size(12).text_color(t.accent).child('SORULAR')).child(div().text_size(12).text_color(t.dim).child('Oturum kaydı')))
    .children((m.questions??[]).map((q,i)=>v_flex().gap(10).child(div().font_semibold().child(q.question??q.title??q.header??'Soru'))
      .children((q.options??[]).map((o,j)=>v_flex().p(12).gap(4).rounded(10).border(1).border_color(t.border).bg(t.surface)
        .child(div().child(`○  ${typeof o==='string'?o:o.label??''}`)).when(Boolean(o.description),e=>e.child(div().text_size(12).text_color(t.dim).child(o.description)))))))
    .child(div().text_size(12).text_color(t.dim).child('Seçenekleri canlı terminalde yanıtlayın; burada geçmiş soru kartları da görünür.'))
    .child(h_flex().justify_end().child(this.button(`answer-${m.id}`,'Terminalde yanıtla →',()=>this.back(),true)));}
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
    const t=theme(), target=this.target;
    const activeTab=spaces().find(s=>s.active)?.tabs?.find(t=>t.active)?.id;
    const same=this.target?.terminal===target?.terminal&&target?.tab===activeTab;
    const data=same?this.data:null;
    const status=terminals().find(x=>x.address===target?.terminal)?.status??data?.status;
    const queue=status==='working'&&data?.kind==='claude'&&!target?.terminal?.includes('/');
    const ready=data&&!this.error&&!this.sending&&!this.pasting&&!this.staged[target?.terminal]&&(['idle','done'].includes(status)||queue);
    const shell=this.shellMode(this.input.value());this.shellDraft=shell;
    const groups=[];
    for(const m of data?.messages??[]){if(m.role==='tool'){if(groups.at(-1)?.role==='tools')groups.at(-1).items.push(m);else groups.push({id:`tools-${m.id}`,role:'tools',items:[m]});}else groups.push(m);}

    return v_flex().id('madlen-chat-root').size_full().min_w(0).min_h(0).font_family('Helvetica Neue').text_size(14).text_color(t.foreground).bg(t.canvas)
      .on_mouse_up('left',()=>{this.dragging=false;}).on_hover(inside=>{if(!inside)this.dragging=false;})
      .child(h_flex().h(42).flex_none().px(16).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().font_medium().child(`${data?.kind==='claude'?'Claude Code':'Codex'} · Sohbet`))
        .child(div().flex_1().truncate().text_size(12).text_color(status==='working'?t.working:status==='blocked'?t.blocked:t.done).child(status==='working'?'● Çalışıyor…':status==='blocked'?'● Yanıtınızı bekliyor':['idle','done'].includes(status)?'✓ Yanıt tamamlandı · Yeni mesaj gönderebilirsiniz':'Oturum bağlanıyor…'))
        .when(Boolean(data?.context),e=>e.child(this.contextMeter(data.context,t)))
        .when(!this.follow&&this.maxOffset()-this.offset>3,e=>e.child(this.button('chat-latest','Son mesaj ↓',cx=>{this.follow=true;this.offset=this.maxOffset();cx.notify();})))
        .child(this.button('chat-refresh','Yenile',cx=>this.refresh(cx)))
        .child(h_flex().p(3).gap(2).rounded(8).bg(t.hover).child(div().px(10).py(4).rounded(6).bg(t.surface).text_color(t.accent).child('Chat')).child(this.button('back-terminal','Terminal',()=>this.back())))
        .children([['split-right','Sağa böl','right'],['split-down','Alta böl','down']].map(([icon,label,direction])=>div().id(`chat-${icon}`).p(6).tooltip(label).cursor_pointer().on_click(()=>{this.back();run('pane.split',{pane:target?.pane,direction});}).child(svg(`mods/madlen-pane/${icon}.svg`).size(14).text_color(t.dim)))))
      .when(Boolean(this.error||this.sendError),e=>e.child(h_flex().flex_none().p(12).gap(12).bg(t.selected).text_color(t.accent).child(div().flex_1().child(this.sendError||this.error)).child(this.button('error-terminal','Terminale dön',()=>this.back()))))
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
          .when(!data,e=>e.child(div().text_color(t.dim).child(!target?'Bu sekmede desteklenen bir sohbet yok. Terminal görünümünü açabilirsiniz.':this.error?'Terminal oturumunuz çalışmaya devam ediyor.':'Sohbet yükleniyor…')))
          .when(Boolean(data?.more),e=>e.child(h_flex().w_full().max_w(this.columnWidth()).justify_center().child(this.button('chat-older',this.pending.has(target?.terminal)?'Yükleniyor…':'Daha eski mesajları göster',cx=>this.older(cx)))))
          .children(groups.map(m=>m.role==='tools'?this.tools(m,t):m.role==='question'?this.question(m,t):m.role==='notice'?this.notice(m,t):m.role==='shell'?this.shell(m,t):this.message(m,t)))
          .when(Boolean(data?.prompt)&&status==='blocked',e=>e.child(this.permission(data.prompt,t)))
          .child(h_flex().flex_none().pl(40).gap(8).items_center().text_size(12).text_color(status==='working'?t.working:status==='blocked'?t.blocked:t.done)
            .when(status==='working',e=>e.child(svg('mods/madlen-chrome/spinner.svg').size(12).spin(900)))
            .child(div().child(status==='working'?'Yanıt hazırlanıyor…':status==='blocked'?'Devam etmek için yanıtınız gerekiyor.':['idle','done'].includes(status)?'✓ Yanıt tamamlandı':'Oturum bağlanıyor…'))))
        .when(this.maxOffset()>0,e=>e.child(div().id('chat-scroll-track').absolute().right(3).top(4).bottom(4).w(9).rounded(5).bg(t.border+'55').cursor_pointer()
          .on_mouse_down('left',(event,cx)=>{if(!event.local_position)return;this.dragging=true;this.scrollThumb(event.local_position.y,cx);cx.stop_propagation();})
          .child(div().absolute().top((this.viewport-8-this.thumbHeight())*(this.maxOffset()?this.offset/this.maxOffset():0)).w(9).h(this.thumbHeight()).rounded(5).bg(t.dim+'88')))))
      .child(div().on_key_up((e,cx)=>{if(e.key==='enter'&&!e.modifiers.shift){cx.stop_propagation();this.send(cx);}}).flex_none().w_full().pl(28).pr(44).mb(18).child(v_flex().w_full().max_w(this.columnWidth()).p(12).gap(8).rounded(14).border(1).border_color(shell?t.accent:t.border).bg(shell?t.background:t.surface)
        .when((this.imageDrafts[target?.terminal]??[]).length>0,e=>e.child(h_flex().gap(8).flex_wrap().children(this.imageDrafts[target.terminal].map((a,i)=>this.thumbnail(a,`draft-${i}`,true)))))
        .on_drop((event,cx)=>this.pasteImages(cx,event.paths??[]))
        .child(Textarea.new(this.input).w_full().min_w(0).flex_none().text_size(shell?14:15).text_color(t.foreground).when(shell,e=>e.font_family(this.mono())))
        .child(h_flex().gap(10).items_center()
          .when(shell,e=>e.child(div().flex_none().px(7).py(2).rounded(6).bg(t.accent+'26').text_color(t.accent).font_semibold().text_size(11).child('! KOMUT')))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(shell?t.muted:t.dim).child(shell&&ready?'Claude Code bu satırı kabukta çalıştırır · çıktı sohbete düşer':ready&&queue?'Agent çalışıyor · gönderirsen sıraya girer, bir sonraki adımda okur':ready?'Enter gönderir · Shift+Enter yeni satır':status==='working'?'Agent çalışıyor. Taslağınızı yazabilirsiniz.':status==='blocked'&&data?.prompt?'İzin isteğini yukarıdaki karttan yanıtlayabilirsin.':'Onaylar ve soru yanıtları için Terminal görünümünü kullanın.'))
          .child(this.button('paste-image',this.pasting?'Ekleniyor…':'Görsel yapıştır',cx=>this.pasteImages(cx)))
          .child(this.button('chat-send',this.sending?'Gönderiliyor…':shell?'Çalıştır →':queue?'Sıraya ekle →':'Gönder →',cx=>{if(ready)this.send(cx);},Boolean(ready))))));
  }
}
