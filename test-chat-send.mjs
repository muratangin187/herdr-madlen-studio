import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./theme/mods/madlen-chat/main.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('export default class MadlenChat','globalThis.MadlenChat=class MadlenChat');
const outbox=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(new URL('./theme/mods/madlen-chat/outbox.js',import.meta.url))).toString('base64'));
const {makeOutgoing,reconcileOutgoing,outgoingFor}=outbox;
const snapshot=(session='sa',extra=[])=>({session,kind:'codex',status:'idle',messages:[{id:'old',role:'user',text:'same'},...extra]});

function setup(){
  let active='a',text='same';
  const requests=[],jobs=[],statuses={ta:'idle',tb:'idle'};
  const views=[{tab:'a',pane:'pa',terminal:'ta',program:{name:'Codex'}},{tab:'b',pane:'pb',terminal:'tb',program:{name:'Codex'}}];
  const context={View:class {},...outbox,theme:()=>({}),settings:()=>({}),props:()=>({}),
    layout:()=>({id:'conversation-surface',active:'madlen-chat-view'}),shared:()=>null,setShared(){},
    spaces:()=>[{active:true,tabs:[{id:active,active:true}]}],panes:()=>views,
    terminals:()=>views.map(p=>({address:p.terminal,status:statuses[p.terminal]})),
    exec:(_bin,args)=>new Promise((resolve,reject)=>requests.push({args,resolve,reject,settled:false})),appHome:()=>'/tmp'};
  vm.createContext(context);vm.runInContext(source,context);
  const view=new context.MadlenChat(),a=snapshot(),b=snapshot('sb');
  Object.assign(view,{outbox:[],nextSend:0,target:{terminal:'ta',pane:'pa',tab:'a'},data:a,cache:new Map([['ta',a],['tb',b]]),
    diskLoaded:new Set(['ta','tb']),updated:new Map(),reports:new Map(),imageDrafts:{},drafts:{},staged:{},pending:new Set(),reload:new Set(),raw:new Map(),limits:{},positions:new Map(),expanded:{},
    viewport:400,contentHeight:600,offset:0,follow:false,historyKey:0,error:'',sendError:'',
    input:{value:()=>text,set_value:value=>{text=value;}}});
  const cx={notify(){},spawn(fn){const job=fn(this);jobs.push(job);return job;}};
  return {view,cx,requests,jobs,statuses,setText:value=>{text=value;},switchTo:value=>{active=value;view.refresh(cx);}};
}

{
  const h=setup(),{view,cx,requests,jobs}=h;
  view.send(cx);
  assert.equal(view.input.value(),'','composer clears before any response');
  assert.equal(view.outbox.length,1);assert.equal(view.outbox[0].state,'sending');
  assert.equal(view.follow,true,'sending follows the new user bubble immediately');
  assert.equal(requests.length,1);
  assert.ok(requests[0].args.includes('same'));
  view.send(cx);h.setText('next draft');view.imageDrafts.ta=[{path:'new.png'}];
  assert.equal(requests.length,1,'Enter/key-up cannot duplicate the in-flight send');
  requests[0].resolve({stdout:'{"ok":true}'});await jobs[0];
  assert.equal(view.input.value(),'next draft','acknowledgment does not erase new typing');
  assert.equal(view.imageDrafts.ta[0].path,'new.png','acknowledgment does not erase new attachments');
  assert.equal(view.outbox[0].state,'sent','accepted messages stay visible until the transcript catches up');
  requests[1].resolve({stdout:JSON.stringify(snapshot('sa',[{id:'new',role:'user',text:'same'}]))});await jobs[1];
  assert.equal(view.outbox.length,0,'native echo replaces the local bubble');
  assert.equal(view.data.messages.filter(m=>m.id==='new').length,1);
}

{
  const {view,cx,requests,jobs}=setup();view.send(cx);view.refresh(cx);
  requests[1].resolve({stdout:JSON.stringify(snapshot('sa',[{id:'new',role:'user',text:'same'}]))});await jobs[1];
  assert.equal(outgoingFor(view.outbox,'ta','sa').length,0,'a transcript arriving before the transport ack never duplicates the bubble');
  assert.equal(view.sendingFor('ta'),true,'the in-flight transport remains guarded');
  requests[0].reject(Error('ack timeout'));await jobs[0];
  assert.equal(view.outbox.length,0,'native proof wins over a late transport timeout');
}

{
  const h=setup(),{view,cx,requests,jobs}=h;view.send(cx);const record=view.outbox[0];h.setText('new draft');
  requests[0].resolve({stdout:'{"error":"Temporarily unavailable","delivery":"not_sent"}'});await jobs[0];
  assert.equal(record.state,'failed');assert.equal(view.input.value(),'new draft');
  view.restore(record,cx);assert.equal(view.input.value(),'new draft','restore never overwrites another draft');
  const before=requests.length;view.retry(record,cx);view.retry(record,cx);
  assert.equal(requests.length,before+1,'retry reuses the same bubble and is single-flight');
  assert.equal(view.outbox.length,1);assert.equal(view.outbox[0].id,record.id);
  assert.ok(requests.at(-1).args.includes('same'));
  requests.at(-1).resolve({stdout:'{"error":"Still unavailable","delivery":"not_sent"}'});await jobs.at(-1);
  h.setText('');view.restore(record,cx);
  assert.equal(view.input.value(),'same');assert.equal(view.outbox.length,0);
}

{
  const {view,cx,requests,jobs}=setup();view.send(cx);const record=view.outbox[0];
  requests[0].reject(Error('network timeout'));await jobs[0];
  assert.equal(record.state,'uncertain');const before=requests.length;
  view.retry(record,cx);assert.equal(requests.length,before,'uncertain delivery is never blindly retried');
}

{
  const h=setup(),{view,cx,requests,jobs}=h;view.send(cx);h.switchTo('b');h.setText('B draft');
  assert.equal(view.target.terminal,'tb');assert.equal(outgoingFor(view.outbox,'tb','sb').length,0);
  view.send(cx);assert.ok(requests.at(-1).args.includes('tb'),'another terminal can send while A awaits its ack');
  h.setText('B next draft');requests[0].resolve({stdout:'{"ok":true}'});await jobs[0];
  assert.equal(view.input.value(),'B next draft','a late result for A cannot clear B');
  assert.equal(view.target.terminal,'tb');
}

{
  const a=makeOutgoing('1',{terminal:'ta'},snapshot(),'same',[]),b=makeOutgoing('2',{terminal:'ta'},snapshot(),'same',[]);
  a.state='sent';b.state='sent';let items=[a,b];
  items=reconcileOutgoing(items,snapshot('sa',[{id:'one',role:'user',text:'same'}]),'ta');
  assert.equal(items.length,1,'one provider record acknowledges one identical submission');
  items=reconcileOutgoing(items,snapshot('sa',[{id:'one',role:'user',text:'same'}]),'ta');
  assert.equal(items.length,1,'a consumed record cannot acknowledge the second send on a later poll');
  items=reconcileOutgoing(items,snapshot('sa',[{id:'one',role:'user',text:'same'},{id:'two',role:'user',text:'same'}]),'ta');
  assert.equal(items.length,0);
  const image=makeOutgoing('img',{terminal:'ta'},snapshot(),'',[{path:'uploads/img.png',width:20,height:20}]);image.state='sent';
  assert.equal(reconcileOutgoing([image],snapshot('sa',[{id:'img',role:'user',text:'[Image #1]',attachments:[{path:'images/img.png'}]}]),'ta').length,0);
  const shell=makeOutgoing('shell',{terminal:'ta'},snapshot(),'! echo test',[],true);shell.state='sent';
  assert.equal(reconcileOutgoing([shell],snapshot('sa',[{id:'sh',role:'user',text:'echo test',shell:true}]),'ta').length,0);
  const old=makeOutgoing('old',{terminal:'ta'},snapshot(),'message',[]);
  assert.equal(outgoingFor([old],'ta','new-session').length,0,'an echo cannot leak into a different conversation on the same terminal');
}

{
  // A restored first send must reconcile even after Claude wraps a long paste.
  const h=setup(),{view,cx,requests,jobs}=h;
  const initial={...snapshot('process:key'),kind:'claude',process_key:'process:key',unbound:true};
  const item=makeOutgoing('pasted',{terminal:'ta',pane:'pa'},initial,'Birinci satır\nİkinci satır',[]);
  item.state='sent';item.createdAt=5000;
  view.outbox=outbox.restoreOutbox(outbox.serializeOutbox([item]));
  const native={id:'native',role:'user',text:'\n\n<pasted_content id="abcd">\nBirinci satır\nİkinci satır\n</pasted_content id="abcd">\n',at:6000};
  const completed={...snapshot('actual-session',[native,{id:'final',role:'assistant',text:'Tamamlandı',turn_status:'completed'}]),kind:'claude',process_key:'process:key',status:'done'};
  view.refresh(cx);requests[0].resolve({stdout:JSON.stringify(completed)});await jobs[0];
  assert.equal(view.outbox.length,0,'a restored wrapped paste clears the stale waiting bubble');
  assert.equal(view.data.messages.filter(m=>m.id==='native').length,1);
  h.setText('Sonraki mesaj');view.send(cx);
  assert.equal(view.outbox[0].state,'sending','the next prompt sends immediately instead of remaining queued');
  assert.ok(requests[1].args.includes('Sonraki mesaj'));
}
{
  const text='Birinci satır\nİkinci satır';
  const wrapped=body=>`<pasted_content id="abcd">\n${body}\n</pasted_content id="abcd">`;
  const check=(native,kind='claude',mutate=()=>{})=>{
    const item=makeOutgoing('paste',{terminal:'ta'},{...snapshot(),kind},text,[]);item.state='sent';mutate(item);
    return reconcileOutgoing([item],{...snapshot('sa',[{id:'new',role:'user',text:native,at:6000}]),kind},'ta').length;
  };
  assert.equal(check(wrapped(text)),0);
  assert.equal(check(wrapped(text).replace(/\n/g,'\r\n')),0,'pasted Windows line endings match');
  assert.equal(check(wrapped(text).replace('</pasted_content id="abcd">','</pasted_content>')),0);
  assert.equal(check(wrapped('başka metin')),1,'wrapper alone is not proof of delivery');
  assert.equal(check(wrapped(text),'codex'),1,'Claude wrappers are not normalized for Codex');
  assert.equal(check('önce '+wrapped(text)),1,'embedded pasted text is not a whole-message echo');
  assert.equal(check(wrapped(text)+' sonra'),1);
  assert.equal(check(wrapped(text).replace('</pasted_content id="abcd">','</pasted_content id="ffff">')),1,'mismatched IDs are not unwrapped');
  assert.equal(check(wrapped(text),'claude',x=>x.state='queued'),1);
  assert.equal(check(wrapped(text),'claude',x=>x.baseline.add('new')),1);
  assert.equal(check(wrapped(text),'claude',x=>{x.unbound=true;x.createdAt=10000;}),1,'an old echo cannot acknowledge a new process send');
  const literal=makeOutgoing('literal',{terminal:'ta'},{...snapshot(),kind:'claude'},wrapped(text),[]);literal.state='sent';
  assert.equal(reconcileOutgoing([literal],snapshot('sa',[{id:'literal',role:'user',text:wrapped(text)}]),'ta').length,0,'literal wrapper text still matches exactly');
}
{
  const h=setup(),{view,cx,requests,jobs}=h;
  h.statuses.ta='working';view.data.status='working';
  h.setText('First queued message');view.send(cx);
  h.setText('Second queued message');view.send(cx);
  assert.equal(view.input.value(),'');assert.equal(requests.length,0,'working Enter never steers the native agent');
  assert.equal(view.outbox.length,2);assert.ok(view.outbox.every(x=>x.state==='queued'));
  view.pumpQueue(cx);assert.equal(requests.length,0);
  h.statuses.ta='idle';view.pumpQueue(cx);
  assert.equal(requests.length,0,'a stale idle terminal cannot flush a still-working transcript');
  view.data.status='idle';view.pumpQueue(cx);view.pumpQueue(cx);
  assert.equal(requests.length,1,'a terminal flushes only one queued message at a time');
  assert.ok(requests[0].args.includes('First queued message'));
  requests[0].resolve({stdout:'{"ok":true}'});await jobs[0];
  assert.equal(view.outbox[1].state,'queued','ack alone cannot flush the next item');
  requests[1].resolve({stdout:JSON.stringify({...snapshot('sa',[{id:'first',role:'user',text:'First queued message'}]),status:'working'})});await jobs[1];
  assert.equal(view.outbox.length,1);assert.equal(view.outbox[0].text,'Second queued message');
  h.statuses.ta='working';view.pumpQueue(cx);assert.equal(requests.length,2);
  h.statuses.ta='idle';view.data.status='idle';view.pumpQueue(cx);
  assert.ok(requests[2].args.includes('Second queued message'),'FIFO resumes when the first turn finishes');
}
{
  const h=setup(),{view,cx,requests}=h;h.statuses.ta='working';view.data.status='working';
  h.setText('A correction');view.send(cx);const item=view.outbox[0];
  view.steer(item,cx);view.steer(item,cx);
  assert.equal(requests.length,1,'repeated steer clicks cannot duplicate delivery');
  assert.ok(requests[0].args.includes('--mode'));assert.ok(requests[0].args.includes('steer'));
}
{
  const h=setup(),{view,cx,requests,jobs}=h;view.send(cx);
  requests[0].resolve({stdout:'{"deferred":true,"delivery":"not_sent"}'});await jobs[0];
  assert.equal(view.outbox[0].state,'queued','idle-to-working races return the item to the queue');
  view.pumpQueue(cx);assert.equal(requests.length,2,'deferred sends back off instead of spinning');
}
{
  const first=makeOutgoing('startup',{terminal:'ta'}, {...snapshot('process:key'),process_key:'process:key',unbound:true},'First',[]);
  first.state='sent';first.createdAt=5000;
  const snapshotBound={...snapshot('actual-session',[{id:'echo',role:'user',text:'First',at:6000}]),process_key:'process:key'};
  const old={...snapshotBound,messages:[{id:'old',role:'user',text:'First',at:1000}]};
  let items=reconcileOutgoing([first],old,'ta');assert.equal(items.length,1,'startup cannot acknowledge an old identical prompt');
  items=reconcileOutgoing(items,snapshotBound,'ta');assert.equal(items.length,0,'first send follows the exact process into its new transcript');
  const queued=makeOutgoing('queued',{terminal:'ta'},snapshot(),'same',[]);queued.state='queued';
  assert.equal(reconcileOutgoing([queued],snapshot('sa',[{id:'external',role:'user',text:'same'}]),'ta').length,1,'a locally queued item cannot be acknowledged before delivery');
  const restored=outbox.restoreOutbox(outbox.serializeOutbox([queued,{...queued,id:'inflight',state:'sending'}]));
  assert.equal(restored[0].state,'queued');assert.ok(restored[0].baseline instanceof Set);
  assert.equal(restored[1].state,'uncertain','restart never retries an unknown in-flight send');
  queued.process_key='old-process';
  reconcileOutgoing([queued],{...snapshot(),process_key:'new-process'},'ta');
  assert.equal(queued.state,'failed','process replacement cannot auto-send an old queue');
}
console.log('PASS: immediate delivery, durable FIFO queue, steer, startup transition, send races, duplicates, uncertain delivery, drafts and terminal/session isolation');
