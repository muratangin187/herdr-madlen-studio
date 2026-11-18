const normalize=text=>String(text??'').replace(/\r\n/g,'\n').trim();

function claudePaste(text) {
  // Claude stores long terminal pastes inside a whole-message wrapper. Only
  // unwrap that envelope; preserve embedded tags and require matching IDs.
  const match=text.match(/^<pasted_content id="([a-fA-F0-9]+)">\n([\s\S]*)\n<\/pasted_content(?: id="\1")?>$/);
  return match?normalize(match[2]):text;
}

export function makeOutgoing(id,target,snapshot,text,attachments,shell=false) {
  return {id,terminal:target.terminal,pane:target.pane,session:snapshot.session,role:'user',optimistic:true,
    kind:snapshot.kind,process_key:snapshot.process_key,unbound:Boolean(snapshot.unbound),createdAt:Date.now(),mode:'normal',
    inputText:text,text:shell?text.trimStart().slice(1).trimStart():text,shell,
    attachments:attachments.map(a=>({...a})),state:'sending',error:'',observedId:null,
    baseline:new Set(snapshot.messages.filter(m=>m.role==='user').map(m=>m.id))};
}

function matches(item,message) {
  if(item.state==='queued')return false;
  if(message.role!=='user' || item.baseline.has(message.id))return false;
  if(item.unbound && (!Number.isFinite(message.at)||message.at<item.createdAt-1000))return false;
  if(item.shell)return Boolean(message.shell) && normalize(message.text)===normalize(item.text);
  let text=normalize(message.text);
  if(item.attachments.length){
    text=text.replace(/^(?:\[Image\s*#?\d+\]\s*)+/gi,'').trim();
    if((message.attachments?.length??0)<item.attachments.length)return false;
  }
  const expected=normalize(item.text);
  return text===expected || (item.kind==='claude' && claudePaste(text)===expected);
}

// One native user record may acknowledge only one locally submitted message.
// Keep consumed IDs in the other submissions' baselines across polling cycles.
export function reconcileOutgoing(items,snapshot,terminal) {
  for(const item of items){
    if(item.terminal!==terminal)continue;
    if(item.unbound&&item.process_key&&item.process_key===snapshot.process_key&& !snapshot.unbound){
      item.session=snapshot.session;
      // Keep unbound=true until an exact, new user record acknowledges this send.
    }
    if(item.state==='queued'&&item.process_key&&snapshot.process_key&&item.process_key!==snapshot.process_key){
      item.state='failed';item.error='Agent işlemi değişti; mesaj otomatik gönderilmedi.';
    }
  }
  const scope=items.filter(item=>item.terminal===terminal && item.session===snapshot.session);
  const used=new Set(scope.filter(item=>item.observedId).map(item=>item.observedId));
  for(const item of scope){
    if(item.observedId)continue;
    const found=snapshot.messages.find(message=>!used.has(message.id) && matches(item,message));
    if(found){item.observedId=found.id;used.add(found.id);}
  }
  for(const item of scope)for(const id of used)item.baseline.add(id);
  return items.filter(item=>!item.observedId || item.state==='sending');
}

export function outgoingFor(items,terminal,session) {
  return items.filter(item=>item.terminal===terminal && item.session===session && !item.observedId);
}

export function deliveryLabel(item) {
  if(item.state==='queued')return 'Sırada · mevcut çalışma tamamlanınca gönderilecek';
  if(item.state==='sending')return 'Gönderiliyor…';
  if(item.state==='sent')return item.mode==='steer'?'Yönlendirme iletildi':'Gönderildi · Yanıt bekleniyor…';
  if(item.state==='failed')return `Gönderilemedi: ${item.error}`;
  return item.error || 'Gönderim doğrulanamadı. Terminalden kontrol edin.';
}

export function serializeOutbox(items){
  return JSON.stringify(items.map(item=>({...item,baseline:[...item.baseline]})));
}

export function restoreOutbox(raw){
  try{
    const items=JSON.parse(raw??'[]');if(!Array.isArray(items))return [];
    return items.filter(x=>x&&typeof x.id==='string'&&typeof x.terminal==='string'&&typeof x.session==='string'
      &&typeof x.inputText==='string'&&Array.isArray(x.attachments)&&Array.isArray(x.baseline)
      &&['queued','sending','sent','failed','uncertain'].includes(x.state)).map(item=>({...item,
        baseline:new Set(item.baseline),state:item.state==='sending'?'uncertain':item.state,
        error:item.state==='sending'?'Uygulama yenilendi; gönderimi Terminalden kontrol edin.':item.error}));
  }catch(_e){return [];}
}
